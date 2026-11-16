#!/usr/bin/env bash
# Build the site WITH the invite-link gate and upload it to the STAGING environment.
# Production is deployed only by GitHub Actions from main and is not touched here.
#
#   npm run deploy:staging
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-tsv}"
REGION=eu-central-1
STACK=TsvSteinsfurtStaging

output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
BUCKET=$(output BucketName)
DISTRIBUTION_ID=$(output DistributionId)
SITE_URL=$(output SiteUrl)
[ -n "$BUCKET" ] && [ "$BUCKET" != "None" ] || { echo "Stack $STACK nicht gefunden – erst 'npm run staging:infra' ausführen." >&2; exit 1; }

echo "→ Build mit Zugangsschutz für $SITE_URL"
PUBLIC_ACCESS_GATE=true SITE_URL="$SITE_URL" npm run build

echo "→ Upload nach s3://$BUCKET (gleiche Cache-Regeln wie Produktion)"
aws s3 sync dist/_astro "s3://$BUCKET/_astro" --cache-control "public,max-age=31536000,immutable" --only-show-errors
aws s3 sync dist "s3://$BUCKET" --exclude "*.html" --exclude "_astro/*" \
  --cache-control "public,max-age=86400,stale-while-revalidate=604800" --only-show-errors
aws s3 sync dist "s3://$BUCKET" --exclude "*" --include "*.html" --cache-control "no-cache" --only-show-errors
aws s3 sync dist "s3://$BUCKET" --delete --only-show-errors

echo "→ CloudFront-Cache leeren"
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*" --query 'Invalidation.Id' --output text

echo "✓ Staging aktualisiert: $SITE_URL  (Ausschuss-Formular: $SITE_URL/admin/)"
