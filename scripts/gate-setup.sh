#!/usr/bin/env bash
# Setup of the invite-link gate in production (run after `npm run prod:infra`).
#
#   npm run prod:setup                       create HMAC secret + committee password if missing
#   npm run prod:setup -- --rotate-secret     EMERGENCY STOP: new secret → all invite links invalid
#   npm run prod:setup -- --new-password      new random committee password (old one stops working)
#   npm run prod:setup -- --set-password      choose the committee password yourself (asked twice,
#                                             hidden input; without a terminal: one line from stdin)
#
# The HMAC secret lives only in the CloudFront KeyValueStore, the password only as a
# scrypt hash in SSM Parameter Store. A random password is printed once and never stored.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-tsv}"
REGION=eu-central-1
STACK=TsvSteinsfurtSite
INFRA="npm run prod:infra"
PARAM=/tsv-steinsfurt/production/admin-password-hash

ROTATE_SECRET=false
NEW_PASSWORD=false
SET_PASSWORD=false
for arg in "$@"; do
  case "$arg" in
    --rotate-secret) ROTATE_SECRET=true ;;
    --new-password) NEW_PASSWORD=true ;;
    --set-password) SET_PASSWORD=true ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 1 ;;
  esac
done
[ "$NEW_PASSWORD" = true ] && [ "$SET_PASSWORD" = true ] && { echo "--new-password und --set-password nicht zusammen verwenden." >&2; exit 1; }

# Ask for the chosen password first, before anything is changed in AWS.
if [ "$SET_PASSWORD" = true ]; then
  if [ -t 0 ]; then
    read -rs -p "Neues Ausschuss-Passwort: " CHOSEN; echo
    read -rs -p "Passwort wiederholen:     " CHOSEN2; echo
    [ "$CHOSEN" = "$CHOSEN2" ] || { echo "Die Eingaben stimmen nicht überein – nichts geändert." >&2; exit 1; }
    unset CHOSEN2
  else
    IFS= read -r CHOSEN || true
  fi
  # length in characters (not bytes), so "ö" counts once
  [ "$(printf '%s' "$CHOSEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log([...s.normalize("NFC")].length))')" -ge 12 ] \
    || { echo "Das Passwort muss mindestens 12 Zeichen lang sein – nichts geändert." >&2; exit 1; }
fi

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
if [ "$SET_PASSWORD" = true ]; then
  # chosen password goes to the hash script via stdin (never as an argument, never printed)
  HASH=$(printf '%s' "$CHOSEN" | node "$(dirname "$0")/make-password.mjs" --stdin)
  unset CHOSEN
  [[ "$HASH" == scrypt\$* ]] || { echo "Passwort-Hash fehlgeschlagen" >&2; exit 1; }
  aws ssm put-parameter --region "$REGION" --name "$PARAM" --type SecureString --overwrite --value "$HASH" >/dev/null
  echo "✓ Ausschuss-Passwort gesetzt (gespeichert nur als Hash)."
elif aws ssm get-parameter --region "$REGION" --name "$PARAM" >/dev/null 2>&1 && [ "$NEW_PASSWORD" = false ]; then
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
