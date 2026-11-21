// PostgreSQL and Valkey: archives this repository hosts as GitHub releases, made by
// mirror-postgresql.yml (tags postgresql-<theseus version>) and build-valkey.yml
// (tags valkey-<version>). Each archive has a `<name>.sha256` asset next to it.
import { fetchJson, fetchText } from '../download.mjs'
import { compareVersions } from '../manifest.mjs'

const API = 'https://api.github.com'
const PAGE_SIZE = 100

async function listReleases(repository) {
  const headers = { accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const releases = []
  for (let page = 1; ; page++) {
    const batch = await fetchJson(`${API}/repos/${repository}/releases?per_page=${PAGE_SIZE}&page=${page}`, headers)
    releases.push(...batch.filter((r) => !r.draft && !r.prerelease))
    if (batch.length < PAGE_SIZE) return releases
  }
}

async function readSha256(assets, name) {
  const asset = assets.find((a) => a.name === `${name}.sha256`)
  if (!asset) throw new Error(`release asset ${name}.sha256 is missing`)
  const hex = (await fetchText(asset.browser_download_url)).trim().split(/\s+/)[0].toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${name}.sha256 does not hold a sha256`)
  return hex
}

async function buildFrom(assets, name, extra) {
  const asset = assets.find((a) => a.name === name)
  if (!asset) return undefined
  return { url: asset.browser_download_url, sha256: await readSha256(assets, name), sizeBytes: asset.size, ...extra }
}

/** Newest release per series among tags `<prefix>-<version>`. */
function newestPerSeries(releases, prefix, series, seriesOfVersion) {
  const tagged = releases
    .map((r) => ({ release: r, version: r.tag_name.slice(prefix.length + 1) }))
    .filter(({ release, version }) => release.tag_name.startsWith(`${prefix}-`) && /^\d+(\.\d+){1,2}$/.test(version))
    .sort((a, b) => compareVersions(b.version, a.version))
  return series.map((s) => tagged.find(({ version }) => seriesOfVersion(version) === s)).filter(Boolean)
}

const POSTGRES_TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

export async function postgresqlCandidates(config, repository) {
  const releases = await listReleases(repository)
  // theseus-rs versions are <major>.<minor>.<build>; the PostgreSQL version is the first two.
  const picked = newestPerSeries(releases, 'postgresql', config.series, (v) => v.split('.')[0])
  return Promise.all(picked.map(async ({ release, version }) => {
    const platforms = {}
    for (const [platform, target] of Object.entries(POSTGRES_TARGETS)) {
      const build = await buildFrom(release.assets, `postgresql-${version}-${target}.tar.gz`, { format: 'tar.gz', stripComponents: 1, binDir: 'bin', license: config.license })
      if (build) platforms[platform] = build
    }
    const pgVersion = version.split('.').slice(0, 2).join('.')
    return { version: pgVersion, major: Number(version.split('.')[0]), series: version.split('.')[0], platforms }
  }))
}

export async function valkeyCandidates(config, repository) {
  const releases = await listReleases(repository)
  const picked = newestPerSeries(releases, 'valkey', config.series, (v) => v.split('.').slice(0, 2).join('.'))
  return Promise.all(picked.map(async ({ release, version }) => {
    const platforms = {}
    for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
      const extra = { format: 'tar.gz', stripComponents: 1, binDir: 'bin', license: config.license }
      if (platform.startsWith('darwin')) extra.minOsVersion = config.macosDeploymentTarget
      const build = await buildFrom(release.assets, `valkey-${version}-${platform}.tar.gz`, extra)
      if (build) platforms[platform] = build
    }
    return { version, major: Number(version.split('.')[0]), series: version.split('.').slice(0, 2).join('.'), platforms }
  }))
}
