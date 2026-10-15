#!/usr/bin/env bash
#
# Creates the self-signed code signing identity that macOS desktop builds use
# when no Apple Developer ID is configured, proves it, and stores it as the
# GitHub secrets MACOS_SELF_SIGNED_P12 (base64 .p12) and
# MACOS_SELF_SIGNED_P12_PASSWORD. Nothing secret is printed or kept on disk.
#
# Squirrel.Mac only installs an update whose designated requirement matches the
# running app. Ad hoc signatures differ on every build; this certificate gives a
# requirement that stays the same, so in-app updates work without an Apple
# account. See docs/operations/app-distribution.md.
#
#   scripts/release-identity/macos-self-signed.sh            # create once
#   scripts/release-identity/macos-self-signed.sh --rotate   # replace (installs must be updated by hand once)
#
# Needs macOS (security, codesign), openssl and an authenticated gh.

set -euo pipefail

REPO="${GH_REPO:-JustYannicc/signalbox}"
COMMON_NAME="Signalbox Self-Signed Code Signing"
IDENTIFIER="com.justyannicc.signalbox"

case "${1:-}" in
  "") rotate=false ;;
  --rotate) rotate=true ;;
  *) echo "Usage: $0 [--rotate]" >&2; exit 2 ;;
esac

if ! $rotate && grep -qx MACOS_SELF_SIGNED_P12 <<<"$(gh secret list -R "$REPO" --json name -q '.[].name')"; then
  echo "MACOS_SELF_SIGNED_P12 already exists in $REPO. Rotating breaks in-app updates for"
  echo "existing installs (they must install the next build by hand). Re-run with --rotate to replace it."
  exit 1
fi

work="$(mktemp -d)"
keychain="$work/identity.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

P12_PASSWORD="$(openssl rand -hex 24)"
export P12_PASSWORD
keychain_password="$(openssl rand -hex 16)"

cat > "$work/cert.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $COMMON_NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

# 20 years: codesign refuses an expired certificate, and replacing it costs
# every install one manual update.
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 7300 \
  -config "$work/cert.cnf" -keyout "$work/key.pem" -out "$work/cert.pem"

# 3DES/SHA1 PKCS#12 so `security import` reads it on every macOS runner image.
openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$COMMON_NAME" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout env:P12_PASSWORD -out "$work/identity.p12"
rm -f "$work/key.pem"

# Prove it the way CI will use it: import into a throwaway keychain, sign two
# different binaries, and check the second satisfies the first's requirement.
security create-keychain -p "$keychain_password" "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/identity.p12" -k "$keychain" -P "$P12_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
identity="$(security find-identity -p codesigning "$keychain" | awk '/^ *1\)/ { print $2; exit }')"
[[ -n "$identity" ]] || { echo "No code signing identity in the generated .p12." >&2; exit 1; }

cp /usr/bin/true "$work/first"
cp /usr/bin/false "$work/second"
for binary in first second; do
  codesign --force --keychain "$keychain" -s "$identity" -i "$IDENTIFIER" "$work/$binary"
done
requirement="$(codesign -d -r- "$work/first" 2>&1 | sed -n 's/^designated => //p')"
[[ "$requirement" == *"certificate leaf = H\""* ]] || { echo "Unexpected designated requirement: $requirement" >&2; exit 1; }
codesign --verify -R="$requirement" "$work/second"
echo "Designated requirement (identical across builds): $requirement"

# Password first: if the .p12 write then fails on a first run, nothing blocks a plain re-run.
printf '%s' "$P12_PASSWORD" | gh secret set MACOS_SELF_SIGNED_P12_PASSWORD -R "$REPO"
base64 -i "$work/identity.p12" | gh secret set MACOS_SELF_SIGNED_P12 -R "$REPO"
echo "Stored MACOS_SELF_SIGNED_P12 and MACOS_SELF_SIGNED_P12_PASSWORD in $REPO."
