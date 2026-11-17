#!/usr/bin/env bash
# Setup of the invite-link gate (run after `npm run prod:infra` / `npm run staging:infra`).
# Production and staging each have their own secret, password and invite table.
#
#   npm run prod:setup                       create HMAC secret + committee password if missing
#   npm run prod:setup -- --rotate-secret     EMERGENCY STOP: new secret → all invite links invalid
#   npm run prod:setup -- --new-password      new committee password (old one stops working)
#   (same options for staging: npm run staging:setup …)
#
# The HMAC secret lives only in the CloudFront KeyValueStore, the password only as a
# scrypt hash in SSM Parameter Store. The plain password is printed once and never stored.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-tsv}"
REGION=eu-central-1
case "${1:-}" in
  production) STACK=TsvSteinsfurtSite;    INFRA="npm run prod:infra" ;;
  staging)    STACK=TsvSteinsfurtStaging; INFRA="npm run staging:infra" ;;
  *) echo "Aufruf: gate-setup.sh production|staging [--rotate-secret] [--new-password]" >&2; exit 1 ;;
esac
ENV_NAME="$1"; shift
PARAM=/tsv-steinsfurt/$ENV_NAME/admin-password-hash
echo "→ Umgebung: $ENV_NAME ($STACK)"

ROTATE_SECRET=false
NEW_PASSWORD=false
for arg in "$@"; do
  case "$arg" in
    --rotate-secret) ROTATE_SECRET=true ;;
    --new-password) NEW_PASSWORD=true ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 1 ;;
  esac
done

output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
KVS_ARN=$(output KvsArn)
[ -n "$KVS_ARN" ] && [ "$KVS_ARN" != "None" ] || { echo "Zugangsschutz in $STACK nicht gefunden – erst '$INFRA' ausführen." >&2; exit 1; }

# ---------- HMAC secret in the KeyValueStore ----------
if aws cloudfront-keyvaluestore get-key --kvs-arn "$KVS_ARN" --key secret >/dev/null 2>&1 && [ "$ROTATE_SECRET" = false ]; then
  echo "✓ HMAC-Schlüssel existiert bereits (unverändert)."
else
  ETAG=$(aws cloudfront-keyvaluestore describe-key-value-store --kvs-arn "$KVS_ARN" --query ETag --output text)
  aws cloudfront-keyvaluestore put-key --kvs-arn "$KVS_ARN" --if-match "$ETAG" \
    --key secret --value "$(openssl rand -hex 32)" >/dev/null
  if [ "$ROTATE_SECRET" = true ]; then
    echo "✓ NOT-AUS: neuer HMAC-Schlüssel gesetzt – alle bisherigen Einladungslinks werden innerhalb von etwa einer Minute ungültig."
  else
    echo "✓ HMAC-Schlüssel erzeugt."
  fi
fi

# ---------- Committee password (scrypt hash in SSM) ----------
if aws ssm get-parameter --region "$REGION" --name "$PARAM" >/dev/null 2>&1 && [ "$NEW_PASSWORD" = false ]; then
  echo "✓ Ausschuss-Passwort existiert bereits (unverändert)."
else
  # 4 groups of 5 characters, without easily confused characters (0/O, 1/l/I)
  # Password + scrypt hash from a small Node script (no `tr | head` pipe: with pipefail
  # its SIGPIPE would abort this script silently).
  read -r PASSWORD HASH < <(node "$(dirname "$0")/make-password.mjs")
  [ -n "$PASSWORD" ] && [[ "$HASH" == scrypt\$* ]] || { echo "Passwort-Erzeugung fehlgeschlagen" >&2; exit 1; }
  aws ssm put-parameter --region "$REGION" --name "$PARAM" --type SecureString --overwrite --value "$HASH" >/dev/null
  echo
  echo "✓ Neues Ausschuss-Passwort (wird NUR JETZT angezeigt, bitte sicher weitergeben):"
  echo
  echo "      $PASSWORD"
  echo
fi

echo "Fertig. Hinweis: Änderungen greifen in der API spätestens nach 60 Sekunden."
