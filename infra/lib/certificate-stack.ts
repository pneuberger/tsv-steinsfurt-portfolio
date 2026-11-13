import { Stack, type StackProps } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

export interface CertificateStackProps extends StackProps {
  domainName: string;
  hostedZoneId: string;
  hostedZoneName: string;
}

/** TLS certificate for CloudFront. Must live in us-east-1; contains no site content. */
export class CertificateStack extends Stack {
  readonly certificate: Certificate;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, props);

    const zone = HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    this.certificate = new Certificate(this, 'Certificate', {
      domainName: props.domainName,
      validation: CertificateValidation.fromDns(zone),
    });
  }
}
