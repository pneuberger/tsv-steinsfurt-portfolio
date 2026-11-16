#!/usr/bin/env bash
# One-time setup of the invite-link gate in STAGING (run after `npm run staging:infra`).
#
#   npm run staging:setup                    create HMAC secret + committee password if missing
#   npm run staging:setup -- --rotate-secret  EMERGENCY STOP: new secret → all invite links invalid
#   npm run staging:setup -- --new-password   new committee password (old one stops working)
#
# The HMAC secret lives only in the CloudFront KeyValueStore, the password only as a
# scrypt hash in SSM Parameter Store. The plain password is printed once and never stored.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-tsv}"
REGION=eu-central-1
STACK=TsvSteinsfurtStaging
PARAM=/tsv-steinsfurt/staging/admin-password-hash

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
[ -n "$KVS_ARN" ] && [ "$KVS_ARN" != "None" ] || { echo "Stack $STACK nicht gefunden – erst 'npm run staging:infra' ausführen." >&2; exit 1; }

# ---------- HMAC secret in the KeyValueStore ----------
if aws cloudfront-keyvaluestore get-key --kvs-arn "$KVS_ARN" --key secret >/dev/null 2>&1 && [ "$ROTATE_SECRET" = false ]; then
  echo "✓ HMAC-Schlüssel existiert bereits (unverändert)."
else
  ETAG=$(aws cloudfront-keyvaluestore describe-key-value-store --kvs-arn "$KVS_ARN" --query ETag --output text)
  aws cloudfront-keyvaluestore put-key --kvs-arn "$KVS_ARN" --if-match "$ETAG" \
    --key secret --value "$(openssl rand -hex 32)" >/dev/null
  if [ "$ROTATE_SECRET" = true ]; then
    echo "✓ NOT-AUS: neuer HMAC-Schlüssel gesetzt – alle bisherigen Einladungslinks sind ab sofort ungültig."
  else
    echo "✓ HMAC-Schlüssel erzeugt."
  fi
fi

# ---------- Committee password (scrypt hash in SSM) ----------
if aws ssm get-parameter --region "$REGION" --name "$PARAM" >/dev/null 2>&1 && [ "$NEW_PASSWORD" = false ]; then
  echo "✓ Ausschuss-Passwort existiert bereits (unverändert)."
else
  # 4 groups of 5 characters, without easily confused characters (0/O, 1/l/I)
  PASSWORD=$(LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789' </dev/urandom | head -c 20 | sed -E 's/(.{5})(.{5})(.{5})(.{5})/\1-\2-\3-\4/')
  HASH=$(PW="$PASSWORD" node -e '
    const { scryptSync, randomBytes } = require("node:crypto");
    const N = 32768, salt = randomBytes(16);
    const hash = scryptSync(process.env.PW, salt, 32, { N, maxmem: 256 * 1024 * 1024 });
    process.stdout.write(`scrypt$${N}$${salt.toString("hex")}$${hash.toString("hex")}`);
  ')
  aws ssm put-parameter --region "$REGION" --name "$PARAM" --type SecureString --overwrite --value "$HASH" >/dev/null
  echo
  echo "✓ Neues Ausschuss-Passwort (wird NUR JETZT angezeigt, bitte sicher weitergeben):"
  echo
  echo "      $PASSWORD"
  echo
fi

echo "Fertig. Hinweis: Änderungen greifen in der API spätestens nach 60 Sekunden."
