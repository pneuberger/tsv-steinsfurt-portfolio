import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { FunctionUrlAuthType, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { readFileSync } from 'node:fs';
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
  KeyValueStore,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
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
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
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
  /** GitHub Actions deploy role. Omit for environments deployed by hand. */
  github?: {
    /** "owner/repo" */
    repo: string;
    branch: string;
    /**
     * Numeric GitHub IDs of owner and repository. GitHub's OIDC `sub` claim embeds them
     * ("repo:owner@<ownerId>/repo@<repoId>:ref:…"), which ties the role to this exact repo
     * even if a repo with the same name is ever recreated.
     */
    ownerId?: string;
    repoId?: string;
    /** Only one GitHub OIDC provider can exist per AWS account. Set false if it already exists. */
    createOidcProvider: boolean;
  };
  /**
   * Invite-link access gate (private site). Enabled in production.
   * Adds: CloudFront KeyValueStore + gate functions, /api/* → Lambda (invite API), DynamoDB table.
   */
  accessGate?: {
    /** SSM SecureString holding the committee password hash (created by `npm run prod:setup`). */
    passwordParameterName: string;
  };
  /** Distribution comment (shown in the AWS console). */
  comment?: string;
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
    const fnFile = (name: string) => fileURLToPath(new URL(`../functions/${name}`, import.meta.url));
    const gate = props.accessGate;
    let functionAssociations;
    let gateStore: KeyValueStore | undefined;
    if (!gate) {
      // Public site: only map directory URLs to index.html.
      const indexRewrite = new CfFunction(this, 'IndexRewrite', {
        runtime: FunctionRuntime.JS_2_0,
        code: FunctionCode.fromFile({ filePath: fnFile('index-rewrite.js') }),
        comment: 'Map directory URLs (/en/) to index.html',
      });
      functionAssociations = [{ function: indexRewrite, eventType: FunctionEventType.VIEWER_REQUEST }];
    } else {
      // Private site: invite-link gate. HMAC secret + revocation list live in a KeyValueStore.
      gateStore = new KeyValueStore(this, 'GateStore', { comment: 'Invite links: HMAC secret + revoked ids' });
      const gateRequest = new CfFunction(this, 'GateRequest', {
        runtime: FunctionRuntime.JS_2_0,
        code: FunctionCode.fromInline(
          readFileSync(fnFile('gate-request.js'), 'utf8').replace('__KVS_ID__', gateStore.keyValueStoreId),
        ),
        keyValueStore: gateStore,
        comment: 'Invite-link access gate + index.html rewrite',
      });
      const gateResponse = new CfFunction(this, 'GateResponse', {
        runtime: FunctionRuntime.JS_2_0,
        code: FunctionCode.fromFile({ filePath: fnFile('gate-response.js') }),
        comment: 'Store invite token in a cookie',
      });
      functionAssociations = [
        { function: gateRequest, eventType: FunctionEventType.VIEWER_REQUEST },
        { function: gateResponse, eventType: FunctionEventType.VIEWER_RESPONSE },
      ];
    }

    const headers = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      // Don't advertise the hosting stack (S3 origin, encryption, object versions).
      // ETag stays – browsers need it for cache revalidation.
      removeHeaders: ['server', 'x-amz-server-side-encryption', 'x-amz-version-id'],
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            // The site needs none of these browser features – switch them all off.
            header: 'Permissions-Policy',
            value: [
              'accelerometer=()',
              'autoplay=(self)', // muted background clips
              'browsing-topics=()',
              'camera=()',
              'display-capture=()',
              'fullscreen=(self)', // video controls in the lightbox
              'geolocation=()',
              'gyroscope=()',
              'interest-cohort=()',
              'magnetometer=()',
              'microphone=()',
              'midi=()',
              'payment=()',
              'publickey-credentials-get=()',
              'screen-wake-lock=()',
              'serial=()',
              'usb=()',
              'xr-spatial-tracking=()',
            ].join(', '),
            override: true,
          },
        ],
      },
    });

    const distribution = new Distribution(this, 'Distribution', {
      comment: props.comment ?? 'TSV Steinsfurt recruitment site',
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
        functionAssociations,
      },
      // Unknown paths land on the one-pager instead of an S3 XML error.
      // With the access gate they land on the public no-access page instead – otherwise
      // a missing file under a public path (e.g. /logo/x.svg) would serve the private page.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 404,
        responsePagePath: gate ? '/no-access/index.html' : '/index.html',
        ttl: Duration.minutes(5),
      })),
    });

    // ---------- Invite API (only with access gate) ----------
    if (gate && gateStore) {
      const table = new Table(this, 'Invites', {
        partitionKey: { name: 'id', type: AttributeType.STRING },
        billingMode: BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: 'ttl', // entries are deleted 30 days after the link expires
        removalPolicy: RemovalPolicy.DESTROY,
      });
      // Site URL for the revocation check. Stored in SSM instead of passing the domain to the
      // Lambda directly: the distribution already depends on the Lambda (/api/* origin).
      const siteUrlParam = `${gate.passwordParameterName.replace(/\/[^/]+$/, '')}/site-url`;
      new StringParameter(this, 'SiteUrlParam', {
        parameterName: siteUrlParam,
        stringValue: props.dns ? `https://${props.dns.domainName}` : `https://${distribution.distributionDomainName}`,
        description: 'Public site URL, used by the invite API to verify revocations',
      });
      const api = new NodejsFunction(this, 'InviteApi', {
        entry: fileURLToPath(new URL('../lambda/invites/index.ts', import.meta.url)),
        runtime: Runtime.NODEJS_26_X, // same runtime as the site build
        memorySize: 256, // scrypt needs ~32 MB
        timeout: Duration.seconds(10),
        environment: {
          TABLE_NAME: table.tableName,
          KVS_ARN: gateStore.keyValueStoreArn,
          PASSWORD_PARAM: gate.passwordParameterName,
          SITE_URL_PARAM: siteUrlParam,
        },
        bundling: { format: OutputFormat.ESM, minify: true, target: 'node26', externalModules: [], banner: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
        description: 'Invite-link API for the committee form',
      });
      table.grantReadWriteData(api);
      api.addToRolePolicy(new PolicyStatement({
        actions: ['cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:GetKey', 'cloudfront-keyvaluestore:PutKey'],
        resources: [gateStore.keyValueStoreArn],
      }));
      api.addToRolePolicy(new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [gate.passwordParameterName, siteUrlParam].map((name) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`),
      }));
      api.addToRolePolicy(new PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
      }));
      const apiUrl = api.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM });
      distribution.addBehavior('/api/*', FunctionUrlOrigin.withOriginAccessControl(apiUrl), {
        viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: headers,
      });
      new CfnOutput(this, 'KvsArn', { value: gateStore.keyValueStoreArn });
      new CfnOutput(this, 'InvitesTable', { value: table.tableName });
    }

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

    // ---------- Outputs ----------
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName, description: 'GitHub variable AWS_S3_BUCKET' });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId, description: 'GitHub variable AWS_CLOUDFRONT_DISTRIBUTION_ID' });
    new CfnOutput(this, 'SiteUrl', {
      value: props.dns ? `https://${props.dns.domainName}` : `https://${distribution.distributionDomainName}`,
    });
    if (!props.github) return;

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

    const { repo, branch, ownerId, repoId } = props.github;
    const [owner, repoName] = repo.split('/');
    const allowedSubjects = [
      // Format with immutable IDs (what GitHub currently sends)
      ...(ownerId && repoId ? [`repo:${owner}@${ownerId}/${repoName}@${repoId}:ref:refs/heads/${branch}`] : []),
      // Classic name-only format
      `repo:${repo}:ref:refs/heads/${branch}`,
    ];

    const deployRole = new Role(this, 'GithubDeployRole', {
      description: `Deploys the site from ${props.github.repo}@${props.github.branch}`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new WebIdentityPrincipal(oidcProvider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': allowedSubjects,
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

    new CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn, description: 'GitHub variable AWS_DEPLOY_ROLE_ARN' });
  }
}
