#!/usr/bin/env bash
# Mirrors the newest theseus-rs/postgresql-binaries release of each major in sources.json
# as a release `postgresql-<version>` here: the archives byte for byte, their .sha256 files
# and PostgreSQL's license. Run by mirror-postgresql.yml; needs gh, jq and GH_TOKEN.
#
#   MAJORS="17 18" DRY_RUN=1 dbservers/scripts/mirror-postgresql.sh
set -euo pipefail

UPSTREAM=${UPSTREAM:-theseus-rs/postgresql-binaries}
REPO=${GITHUB_REPOSITORY:-J2TEAM/j2team-code}
TARGETS=(aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc)
DRY_RUN=${DRY_RUN:-0}
FORCE=${FORCE:-0}
UPSTREAM_RELEASE_LIMIT=${UPSTREAM_RELEASE_LIMIT:-400}

here=$(cd "$(dirname "$0")/.." && pwd)
majors=${MAJORS:-$(jq -r '.engines.postgresql.series | join(" ")' "$here/sources.json")}

sha256_check() {
  if command -v sha256sum >/dev/null; then sha256sum -c "$1"; else shasum -a 256 -c "$1"; fi
}

tags=$(gh release list -R "$UPSTREAM" --exclude-drafts --exclude-pre-releases -L "$UPSTREAM_RELEASE_LIMIT" --json tagName -q '.[].tagName')

for major in $majors; do
  tag=$(grep -E "^${major}\.[0-9]+\.[0-9]+$" <<<"$tags" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1 || true)
  if [ -z "$tag" ]; then
    echo "::warning::no upstream release for PostgreSQL $major"
    continue
  fi
  ours="postgresql-$tag"
  if [ "$FORCE" != 1 ] && gh release view "$ours" -R "$REPO" >/dev/null 2>&1; then
    echo "$ours already mirrored"
    continue
  fi

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  for target in "${TARGETS[@]}"; do
    name="postgresql-$tag-$target.tar.gz"
    gh release download "$tag" -R "$UPSTREAM" -p "$name" -p "$name.sha256" -D "$work" --clobber
    # The .sha256 must name exactly this file, or `-c` would check something else.
    if [ "$(awk '{print $2}' "$work/$name.sha256" | sed 's/^\*//')" != "$name" ]; then
      echo "::error::$name.sha256 names another file"
      exit 1
    fi
    (cd "$work" && sha256_check "$name.sha256")
  done

  # COPYRIGHT is the PostgreSQL License text the archives carry.
  first="postgresql-$tag-${TARGETS[0]}"
  tar -xzf "$work/$first.tar.gz" -C "$work" "$first/COPYRIGHT"
  mv "$work/$first/COPYRIGHT" "$work/LICENSE"
  rmdir "$work/$first"

  pg_version=$(cut -d. -f1-2 <<<"$tag")
  {
    echo "PostgreSQL $pg_version for J2TEAM Code, mirrored byte for byte from"
    echo "https://github.com/$UPSTREAM/releases/tag/$tag (upstream sha256 checked)."
    echo
    echo "License: PostgreSQL License (see LICENSE). Each archive also carries COPYRIGHT and"
    echo "dependency-notices/ for the bundled libraries."
    echo
    echo '```'
    cat "$work"/*.sha256
    echo '```'
  } >"$work/notes.md"

  if [ "$DRY_RUN" = 1 ]; then
    echo "would create $ours with:"
    ls -l "$work"
  else
    # gh release create refuses an existing tag; FORCE replaces only this one release.
    if [ "$FORCE" = 1 ] && gh release view "$ours" -R "$REPO" >/dev/null 2>&1; then
      gh release delete "$ours" -R "$REPO" --cleanup-tag --yes
    fi
    gh release create "$ours" -R "$REPO" --latest=false \
      --title "PostgreSQL $pg_version (theseus-rs $tag)" --notes-file "$work/notes.md" \
      "$work"/*.tar.gz "$work"/*.sha256 "$work/LICENSE"
  fi
  rm -rf "$work"
  trap - EXIT
done
