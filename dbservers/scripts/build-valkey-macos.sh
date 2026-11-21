#!/usr/bin/env bash
# Builds valkey-server and valkey-cli for the runner's macOS architecture, checks they link
# only system libraries and answer PING, and packages them with Valkey's license into
# dist/valkey-<version>-<platform>.tar.gz plus a .sha256.
#
#   dbservers/scripts/build-valkey-macos.sh 9.0.8 darwin-arm64
set -euo pipefail

version=$1
platform=$2
case "$platform" in
  darwin-arm64) arch=arm64 ;;
  darwin-x64) arch=x86_64 ;;
  *) echo "::error::unknown platform $platform"; exit 1 ;;
esac

here=$(cd "$(dirname "$0")/.." && pwd)
root=$(pwd)
work=${RUNNER_TEMP:-$(mktemp -d)}/valkey-build
smoke_port=${SMOKE_PORT:-6390}
export MACOSX_DEPLOYMENT_TARGET
MACOSX_DEPLOYMENT_TARGET=$(jq -r '.engines.valkey.macosDeploymentTarget' "$here/sources.json")

if [ "$(uname -m)" != "$arch" ]; then
  echo "::error::runner is $(uname -m), expected $arch for $platform"
  exit 1
fi

bash "$here/scripts/fetch-valkey-source.sh" "$version" "$work"
src="$work/valkey-$version"
make -C "$src" -j"$(sysctl -n hw.ncpu)" BUILD_TLS=no USE_SYSTEMD=no valkey-server valkey-cli

bins=("$src/src/valkey-server" "$src/src/valkey-cli")
for bin in "${bins[@]}"; do
  lipo -archs "$bin" | grep -qx "$arch" || { echo "::error::$bin is $(lipo -archs "$bin")"; exit 1; }
  # Anything outside the OS (Homebrew's OpenSSL, say) would be missing on a user's Mac.
  otool -L "$bin" | tail -n +2 | awk '{print $1}' | while read -r lib; do
    case "$lib" in
      /usr/lib/* | /System/Library/*) ;;
      *) echo "::error::$(basename "$bin") links $lib, which is not a system library"; exit 1 ;;
    esac
  done
  minos=$(otool -l "$bin" | awk '/LC_BUILD_VERSION/ { found = 1 } found && $1 == "minos" { print $2; exit }')
  echo "$(basename "$bin"): $arch, minos $minos, links $(otool -L "$bin" | tail -n +2 | awk '{print $1}' | tr '\n' ' ')"
  [ "$minos" = "$MACOSX_DEPLOYMENT_TARGET" ] || { echo "::error::minos $minos != $MACOSX_DEPLOYMENT_TARGET"; exit 1; }
done

data=$(mktemp -d)
"$src/src/valkey-server" --port "$smoke_port" --bind 127.0.0.1 --dir "$data" --save '' --daemonize yes --pidfile "$data/valkey.pid"
for _ in $(seq 1 50); do "$src/src/valkey-cli" -p "$smoke_port" ping 2>/dev/null | grep -q PONG && break; sleep 0.1; done
[ "$("$src/src/valkey-cli" -p "$smoke_port" ping)" = PONG ] || { echo "::error::valkey-server did not answer PING"; exit 1; }
"$src/src/valkey-cli" -p "$smoke_port" set j2team ok >/dev/null
"$src/src/valkey-cli" -p "$smoke_port" save >/dev/null
"$src/src/valkey-cli" -p "$smoke_port" shutdown nosave >/dev/null 2>&1 || true
[ -s "$data/dump.rdb" ] || { echo "::error::SAVE wrote no dump.rdb"; exit 1; }
rm -rf "$data"

name="valkey-$version-$platform"
stage="$work/$name"
mkdir -p "$stage/bin" "$root/dist"
cp "${bins[@]}" "$stage/bin/"
license=""
for candidate in "$src/COPYING" "$src/LICENSE" "$src/LICENSE.txt"; do
  if [ -f "$candidate" ]; then license=$candidate; break; fi
done
[ -n "$license" ] || { echo "::error::no license file in the Valkey source"; exit 1; }
cp "$license" "$stage/LICENSE"
cat >"$stage/README.txt" <<EOF
Valkey $version for macOS $arch (minimum macOS $MACOSX_DEPLOYMENT_TARGET), built for J2TEAM Code
from https://github.com/valkey-io/valkey/archive/refs/tags/$version.tar.gz with BUILD_TLS=no.
License: BSD-3-Clause, see LICENSE.
EOF
tar -czf "$root/dist/$name.tar.gz" -C "$work" "$name"
(cd "$root/dist" && shasum -a 256 "$name.tar.gz" >"$name.tar.gz.sha256")
cat "$root/dist/$name.tar.gz.sha256"
