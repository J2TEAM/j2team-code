# Database server binaries

J2TEAM Code's daemon can run PostgreSQL, MySQL, Valkey (as the Redis engine) and MongoDB for you
and for your agents. It never bundles them: it downloads the archive a user asks for, on demand,
from the URLs in a signed manifest kept here.

```
https://raw.githubusercontent.com/J2TEAM/j2team-code/main/dbservers/manifest.json
https://raw.githubusercontent.com/J2TEAM/j2team-code/main/dbservers/manifest.json.sig
```

The daemon checks `manifest.json.sig` (base64 ed25519 over the exact bytes of `manifest.json`)
against a public key built into the app, then each archive's `sha256` and size, before it
extracts with `tar -xf <archive> --strip-components=<n>` (bsdtar reads both zip and tar.gz on
macOS and Windows).

Platforms: macOS arm64, macOS x64 and Windows x64. Linux comes later.

## What is hosted here and what is only linked

| Engine     | License      | Where the archive comes from                                                                                                                                                                               | Hosted here? |
| ---------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| PostgreSQL | PostgreSQL   | [theseus-rs/postgresql-binaries](https://github.com/theseus-rs/postgresql-binaries), mirrored byte for byte (upstream sha256 checked) as releases `postgresql-<version>`                                  | Yes          |
| Valkey     | BSD-3-Clause | Built here from the [official source tag](https://github.com/valkey-io/valkey) (sha256 checked against [valkey-hashes](https://github.com/valkey-io/valkey-hashes)), released as `valkey-<version>` | Yes          |
| MySQL      | GPL-2.0-only | Oracle's official archives on `cdn.mysql.com`                                                                                                                                                              | **No, linked** |
| MongoDB    | SSPL-1.0     | MongoDB's official archives on `fastdl.mongodb.org`, with the sha256 MongoDB publishes in `current.json`                                                                                                  | **No, linked** |

MySQL (GPL) and MongoDB (SSPL) are never re-hosted: the manifest points at the vendor's own
download, so the vendor's terms apply directly between the user and the vendor. Each manifest
entry carries its SPDX license id so the app can show it before a download.

Each mirrored or built release carries `LICENSE` (PostgreSQL's `COPYRIGHT`, Valkey's `COPYING`)
and a `.sha256` for every archive. The PostgreSQL archives also hold `dependency-notices/` for
the libraries theseus-rs bundles (ICU, OpenSSL, zstd, lz4 and others).

## Manifest

Shape (`manifest.schema.json` is the JSON Schema; the daemon parses the same shape with zod):

```jsonc
{
  "schema": 1,
  "generatedAt": "2026-11-21T08:39:28.588Z",
  "engines": {                       // an engine with nothing published yet is left out
    "mysql": {
      "defaultVersion": "8.4.13",
      "versions": [                  // newest first
        {
          "version": "8.4.13",
          "major": 8,
          "platforms": {             // a platform the vendor did not ship is left out
            "darwin-arm64": {
              "url": "https://cdn.mysql.com/…/mysql-8.4.13-macos15-arm64.tar.gz",
              "sha256": "…",
              "sizeBytes": 167977240,
              "format": "tar.gz",    // tar.gz | tar.xz | zip
              "stripComponents": 1,
              "binDir": "bin",       // relative to the extracted root
              "minOsVersion": "15.0",// optional, major.minor
              "license": "GPL-2.0-only"
            }
          }
        }
      ]
    }
  }
}
```

Things a client must expect:

- An engine may be missing (no build published yet), and a version may lack a platform.
  `defaultVersion` is not always available on every platform: MySQL stopped shipping Intel
  macOS builds with 8.4.12, so the manifest also lists the newest 8.4 patch that has one.
  Pick the newest version of the same series that has the platform.
- MySQL's macOS builds name their minimum macOS (`macos15` → `minOsVersion: "15.0"`). When a
  version ships for several macOS releases, the manifest takes the one for the oldest.

`sources.json` lists the series per engine (PostgreSQL 14–18, MySQL 8.0/8.4/9.7 plus the newest
9.x innovation release, Valkey 8.1/9.0/9.2, MongoDB 7.0/8.0) and which series is the default.
Change it to add or drop a series.

## Workflows

| Workflow                | When                                                       | What it does                                                                                                                       |
| ----------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `mirror-postgresql.yml` | Mondays 02:00 UTC, manual                                  | Newest theseus-rs release per major → release `postgresql-<version>` (archives, `.sha256`, `LICENSE`). Skips what is mirrored.   |
| `build-valkey.yml`      | Mondays 03:00 UTC, manual                                  | Builds the newest Valkey per series on macOS arm64 and x64 (and the Windows spike) → release `valkey-<version>`.                  |
| `refresh-manifest.yml`  | Mondays 05:00 UTC, manual, after either workflow above     | Regenerates the manifest, re-downloads and verifies every archive, signs it, opens a PR `refresh-dbservers-manifest`.              |
| `check-manifest.yml`    | Pushes and PRs touching `dbservers/`                       | Shape and signature, without downloads.                                                                                            |

Releases are created with `--latest=false`, so they never become this repository's "Latest" release.

The refresh PR is opened with the workflow's `GITHUB_TOKEN`, and GitHub does not start other
workflows for such PRs, so `check-manifest.yml` shows no run on it. The refresh job has already
verified every archive and the signature before opening it. Do not make Check manifest a
required status check, or every refresh PR will wait forever.

### Valkey build

`make BUILD_TLS=no` from the source tag with `MACOSX_DEPLOYMENT_TARGET` from `sources.json`
(11.0). The job fails if either binary links anything outside `/usr/lib` and `/System/Library`
(`otool -L`), if its `minos` differs from the target, or if a smoke test (PING, SET, SAVE)
fails. The package is `valkey-<version>-<platform>/{bin/valkey-server, bin/valkey-cli, LICENSE,
README.txt}`. Checked locally for 9.0.8 on macOS arm64: both binaries link only
`/usr/lib/libSystem.B.dylib`, `minos 11.0`.

### Valkey on Windows (spike)

Valkey has no native Windows port. It relies on `fork()` for RDB snapshots (`BGSAVE`) and AOF
rewrites, and on other POSIX APIs. The `build-windows` job tries what
[redis-windows](https://github.com/redis-windows/redis-windows) does for Redis: build inside
MSYS2's POSIX (`msys`) environment, where `msys-2.0.dll` (the Cygwin runtime) emulates `fork()`,
and ship that DLL plus every other `msys-*.dll` the binaries load (found with `ldd`). Its smoke
test includes a forked `BGSAVE`.

Status: written but not yet run, since it needs a Windows runner. The job is
`continue-on-error`. When it fails, the release simply has no Windows archive and the manifest
lists Valkey for macOS only. Known costs of this route, should it work:

- `fork()` under Cygwin copies the whole address space, so `BGSAVE` and AOF rewrites are slow
  and memory-hungry on large datasets. Fine for local development, not for production.
- Paths: Cygwin accepts `C:/…` paths, but `dir`, `logfile` and `pidfile` are safest passed with
  forward slashes.
- The bundled `msys-2.0.dll` is LGPL-3.0 (with a linking exception); the README in the archive
  says so and points at its source.

If the spike cannot work, the alternatives are all worse: Microsoft's archived Redis port stops
at 3.0, Memurai is proprietary, and WSL needs a Linux distribution the user may not have.

## Scripts

All are dependency-free Node 24 (or bash) and run from the repository root.

```bash
node dbservers/scripts/generate-manifest.mjs [--engine mysql ...]  # rebuild manifest.json
node dbservers/scripts/verify-manifest.mjs                         # shape + signature + re-download every archive
node dbservers/scripts/verify-manifest.mjs --no-signature          # before signing
node dbservers/scripts/verify-manifest.mjs --no-download           # shape + signature only
node dbservers/scripts/sign-manifest.mjs                           # needs MANIFEST_SIGNING_KEY or --key-file
node dbservers/scripts/keygen.mjs [--write-public]                 # new key pair
```

`verify-manifest.mjs` also lists each archive with bsdtar and fails if `binDir` lacks the server
binaries after `--strip-components` (on Linux install `libarchive-tools`).

## Signing key

The private key lives only in the repository secret `MANIFEST_SIGNING_KEY` (PKCS8 PEM). The
public key is committed as `manifest-public-key.pem` and built into the daemon as one base64
line (SPKI DER, 44 bytes, `MCowBQYDK2VwAyEA…`).

First setup:

1. `node dbservers/scripts/keygen.mjs --write-public`
2. Paste the private key block into Settings → Secrets and variables → Actions →
   `MANIFEST_SIGNING_KEY`. Do not save it to a file in the repository; clear the terminal.
3. Commit `dbservers/manifest-public-key.pem` and embed the one-line public key in the daemon.
4. Settings → Actions → General → Workflow permissions: allow GitHub Actions to create pull
   requests.
5. Run Mirror PostgreSQL and Build Valkey; Refresh manifest follows each of them.

### Rotating the key

A daemon accepts only the key it was built with, so rotate in this order:

1. Generate a new pair. Add the new public key to the daemon **next to** the old one (accept
   either) and ship that release.
2. Once most installs have it, replace `MANIFEST_SIGNING_KEY` and `manifest-public-key.pem`,
   then run Refresh manifest (it fails if the secret and the committed public key disagree).
3. In a later release, drop the old public key from the daemon.

If the private key leaks, skip the wait: ship a daemon release with only the new key, since
anyone holding the old one can sign a manifest pointing at any archive.
