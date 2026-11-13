import { App } from 'aws-cdk-lib';
import { CertificateStack } from '../lib/certificate-stack.ts';
import { SiteStack } from '../lib/site-stack.ts';

const app = new App();
const ctx = (key: string) => (app.node.tryGetContext(key) as string | undefined) || undefined;

// Account comes from your AWS credentials/profile (e.g. `AWS_PROFILE=tsv npx cdk deploy --all`).
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = 'eu-central-1'; // Frankfurt – all content lives here.

const domainName = ctx('domainName');
const hostedZoneId = ctx('hostedZoneId');
const hostedZoneName = ctx('hostedZoneName');
const dns = domainName && hostedZoneId && hostedZoneName ? { domainName, hostedZoneId, hostedZoneName } : undefined;

// CloudFront only accepts ACM certificates from us-east-1 (AWS requirement).
// This stack holds nothing but the certificate; it is only created when a domain is configured.
const cert = dns
  ? new CertificateStack(app, 'TsvSteinsfurtCertificate', {
      env: { account, region: 'us-east-1' },
      crossRegionReferences: true,
      ...dns,
    })
  : undefined;

new SiteStack(app, 'TsvSteinsfurtSite', {
  env: { account, region },
  crossRegionReferences: true,
  dns: dns && cert ? { ...dns, certificate: cert.certificate } : undefined,
  github: {
    repo: ctx('githubRepo') ?? 'pneuberger/tsv-steinsfurt-portfolio',
    branch: ctx('githubBranch') ?? 'main',
    createOidcProvider: app.node.tryGetContext('createGithubOidcProvider') !== false &&
      app.node.tryGetContext('createGithubOidcProvider') !== 'false',
  },
});
