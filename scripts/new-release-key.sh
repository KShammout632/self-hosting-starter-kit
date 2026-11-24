#!/usr/bin/env bash
# Makes a new Ed25519 release signing key and writes its public half into install.sh and the agent.
# Usage (from the repo root): bash scripts/new-release-key.sh <private key file>
#
# The private key file must stay out of the repository. Store it as the RELEASE_SIGNING_KEY secret:
#   gh secret set RELEASE_SIGNING_KEY < <private key file>
# then keep an offline copy somewhere safe and delete the file. See docs/contributing.md.
set -euo pipefail

KEY_FILE="${1:?Usage: new-release-key.sh <private key file>}"
[ ! -e "$KEY_FILE" ] || {
  echo "$KEY_FILE already exists. Pick a new file name." >&2
  exit 1
}
case "$(realpath -m "$KEY_FILE")" in
  "$(realpath .)"/*)
    echo "Put the private key outside the repository." >&2
    exit 1
    ;;
esac

(umask 077 && openssl genpkey -algorithm ed25519 -out "$KEY_FILE")
public="$(openssl pkey -in "$KEY_FILE" -pubout -outform DER | base64 -w0)"

sed -i "s|^RELEASE_PUBLIC_KEY=\".*\"$|RELEASE_PUBLIC_KEY=\"$public\"|" install.sh
sed -i "s|^export const RELEASE_PUBLIC_KEY = '.*';$|export const RELEASE_PUBLIC_KEY = '$public';|" \
  apps/agent/src/release-key.ts

echo "Private key: $KEY_FILE"
echo "Public key:  $public (written into install.sh and apps/agent/src/release-key.ts)"
