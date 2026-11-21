#!/usr/bin/env bash
# Downloads the official Valkey source tarball for a tag and checks it against the sha256
# Valkey publishes in valkey-io/valkey-hashes, then unpacks it into <dest>/valkey-<version>.
#
#   dbservers/scripts/fetch-valkey-source.sh 9.0.8 /tmp/build
set -euo pipefail

version=$1
dest=$2
hashes_url=${VALKEY_HASHES_URL:-https://raw.githubusercontent.com/valkey-io/valkey-hashes/main/README}
tarball="$dest/valkey-$version.tar.gz"

mkdir -p "$dest"
curl -fsSL -o "$tarball" "https://github.com/valkey-io/valkey/archive/refs/tags/$version.tar.gz"
expected=$(curl -fsSL "$hashes_url" | awk -v f="valkey-$version.tar.gz" '$1 == "hash" && $2 == f && $3 == "sha256" { print $4 }')
if [ -z "$expected" ]; then
  echo "::error::valkey-hashes has no sha256 for valkey-$version.tar.gz yet"
  exit 1
fi
if command -v sha256sum >/dev/null; then actual=$(sha256sum "$tarball" | cut -d' ' -f1); else actual=$(shasum -a 256 "$tarball" | cut -d' ' -f1); fi
if [ "$actual" != "$expected" ]; then
  echo "::error::valkey-$version.tar.gz hashes to $actual, valkey-hashes says $expected"
  exit 1
fi
tar -xzf "$tarball" -C "$dest"
echo "source ok: $dest/valkey-$version ($actual)"
