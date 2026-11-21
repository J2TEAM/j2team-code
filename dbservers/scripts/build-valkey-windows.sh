#!/usr/bin/env bash
# SPIKE: builds Valkey for Windows x64 inside MSYS2's POSIX (msys) environment, the way the
# redis-windows project builds Redis. Valkey has no native Windows port: it needs fork()
# for RDB snapshots and AOF rewrites, which the msys-2.0.dll (Cygwin) runtime emulates.
# The package carries that runtime DLL and the other msys DLLs the binaries load.
# Run from an MSYS2 "msys" shell: dbservers/scripts/build-valkey-windows.sh 9.0.8
set -euo pipefail

version=$1
here=$(cd "$(dirname "$0")/.." && pwd)
root=$(pwd)
work=$(mktemp -d)
smoke_port=${SMOKE_PORT:-6390}

bash "$here/scripts/fetch-valkey-source.sh" "$version" "$work"
src="$work/valkey-$version"

# Same source tweaks redis-windows needs: dladdr() is hidden behind __GNU_VISIBLE in
# Cygwin's dlfcn.h, and the module tests do not build there.
sed -i 's/__GNU_VISIBLE/1/' /usr/include/dlfcn.h
sed -i 's/^all: \(.*\) module_tests$/all: \1/' "$src/src/Makefile" || true

make -C "$src" -j"$(nproc)" BUILD_TLS=no USE_SYSTEMD=no MALLOC=libc CFLAGS="-Wno-char-subscripts" valkey-server valkey-cli

server="$src/src/valkey-server.exe"
cli="$src/src/valkey-cli.exe"

data=$(mktemp -d)
"$server" --port "$smoke_port" --bind 127.0.0.1 --dir "$data" --save '' &
server_pid=$!
for _ in $(seq 1 100); do "$cli" -p "$smoke_port" ping 2>/dev/null | grep -q PONG && break; sleep 0.2; done
[ "$("$cli" -p "$smoke_port" ping | tr -d '\r')" = PONG ] || { echo "::error::valkey-server.exe did not answer PING"; exit 1; }
"$cli" -p "$smoke_port" set j2team ok >/dev/null
# BGSAVE forks: this is the part a Windows build is most likely to get wrong.
"$cli" -p "$smoke_port" bgsave >/dev/null
for _ in $(seq 1 100); do [ -s "$data/dump.rdb" ] && break; sleep 0.2; done
"$cli" -p "$smoke_port" shutdown nosave >/dev/null 2>&1 || kill "$server_pid" || true
[ -s "$data/dump.rdb" ] || { echo "::error::BGSAVE wrote no dump.rdb"; exit 1; }
rm -rf "$data"

name="valkey-$version-win32-x64"
stage="$work/$name"
mkdir -p "$stage/bin" "$root/dist"
cp "$server" "$cli" "$stage/bin/"
# Every msys DLL either binary loads, found by ldd rather than a hand-kept list.
ldd "$server" "$cli" | awk '$3 ~ /^\/usr\/bin\/msys-.*\.dll$/ { print $3 }' | sort -u | xargs -I{} cp {} "$stage/bin/"
license=""
for candidate in "$src/COPYING" "$src/LICENSE" "$src/LICENSE.txt"; do
  if [ -f "$candidate" ]; then license=$candidate; break; fi
done
[ -n "$license" ] || { echo "::error::no license file in the Valkey source"; exit 1; }
cp "$license" "$stage/LICENSE"
cat >"$stage/README.txt" <<EOF
Valkey $version for Windows x64, built for J2TEAM Code with MSYS2 (Cygwin runtime) from
https://github.com/valkey-io/valkey/archive/refs/tags/$version.tar.gz with BUILD_TLS=no.
License: BSD-3-Clause, see LICENSE. bin/msys-*.dll is the MSYS2 runtime (Cygwin, LGPL-3.0
with a linking exception for the DLL; sources at https://github.com/msys2/msys2-runtime).
EOF
tar -czf "$root/dist/$name.tar.gz" -C "$work" "$name"
(cd "$root/dist" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
cat "$root/dist/$name.tar.gz.sha256"
