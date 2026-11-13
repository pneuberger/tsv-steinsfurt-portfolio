import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  Function as CfFunction,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  PriceClass,
  ResponseHeadersPolicy,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  Effect,
  OidcProviderNative,
  PolicyStatement,
  Role,
  WebIdentityPrincipal,
  type IOidcProvider,
} from 'aws-cdk-lib/aws-iam';
import { AaaaRecord, ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';

export interface SiteStackProps extends StackProps {
  dns?: {
    domainName: string;
    hostedZoneId: string;
    hostedZoneName: string;
    certificate: ICertificate;
  };
  github: {
    /** "owner/repo" */
    repo: string;
    branch: string;
    /** Only one GitHub OIDC provider can exist per AWS account. Set false if it already exists. */
    createOidcProvider: boolean;
  };
}

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';

export class SiteStack extends Stack {
  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);

    // ---------- Storage: private bucket in eu-central-1 ----------
    const bucket = new Bucket(this, 'SiteBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------- CDN ----------
    const indexRewrite = new CfFunction(this, 'IndexRewrite', {
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromFile({
        filePath: fileURLToPath(new URL('../functions/index-rewrite.js', import.meta.url)),
      }),
      comment: 'Map directory URLs (/en/) to index.html',
    });

    const headers = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
    });

    const distribution = new Distribution(this, 'Distribution', {
      comment: 'TSV Steinsfurt recruitment site',
      defaultRootObject: 'index.html',
      priceClass: PriceClass.PRICE_CLASS_100, // Europe + North America edges
      httpVersion: HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: props.dns ? SecurityPolicyProtocol.TLS_V1_2_2021 : undefined,
      domainNames: props.dns ? [props.dns.domainName] : undefined,
      certificate: props.dns?.certificate,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED, // honours Cache-Control set at upload time
        compress: true,
        responseHeadersPolicy: headers,
        functionAssociations: [{ function: indexRewrite, eventType: FunctionEventType.VIEWER_REQUEST }],
      },
      // Unknown paths land on the one-pager instead of an S3 XML error.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
      ],
    });

    // ---------- DNS (optional) ----------
    if (props.dns) {
      const zone = HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: props.dns.hostedZoneId,
        zoneName: props.dns.hostedZoneName,
      });
      const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
      new ARecord(this, 'AliasA', { zone, recordName: props.dns.domainName, target });
      new AaaaRecord(this, 'AliasAAAA', { zone, recordName: props.dns.domainName, target });
    }

    // ---------- GitHub Actions deploy role (OIDC, no stored keys) ----------
    const oidcProvider: IOidcProvider = props.github.createOidcProvider
      ? new OidcProviderNative(this, 'GithubOidc', {
          url: GITHUB_OIDC_URL,
          clientIds: ['sts.amazonaws.com'],
        })
      : OidcProviderNative.fromOidcProviderArn(
          this,
          'GithubOidc',
          `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
        );

    const deployRole = new Role(this, 'GithubDeployRole', {
      description: `Deploys the site from ${props.github.repo}@${props.github.branch}`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new WebIdentityPrincipal(oidcProvider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${props.github.repo}:ref:refs/heads/${props.github.branch}`,
        },
      }),
    });

    deployRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
      }),
    );
    deployRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:PutObject', 's3:DeleteObject', 's3:GetObject'],
        resources: [bucket.arnForObjects('*')],
      }),
    );
    deployRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
      }),
    );

    // ---------- Outputs → GitHub repository variables ----------
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName, description: 'GitHub variable AWS_S3_BUCKET' });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId, description: 'GitHub variable AWS_CLOUDFRONT_DISTRIBUTION_ID' });
    new CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn, description: 'GitHub variable AWS_DEPLOY_ROLE_ARN' });
    new CfnOutput(this, 'SiteUrl', {
      value: props.dns ? `https://${props.dns.domainName}` : `https://${distribution.distributionDomainName}`,
    });
  }
}
