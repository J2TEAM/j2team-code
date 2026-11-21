// MySQL Community Server: official cdn.mysql.com archives, linked only, never re-hosted (GPL).
// dev.mysql.com refuses scripted clients, so versions are found by probing the CDN: a
// release lives under /archives/mysql-S/ once superseded and under /Downloads/MySQL-S/ while
// current. MySQL publishes MD5 only, so the generator downloads each archive for its sha256.
import { mapPool, probe } from '../download.mjs'

const CDN = 'https://cdn.mysql.com'
const PROBE_CONCURRENCY = 8

const seriesOf = (version) => version.split('.').slice(0, 2).join('.')
const archiveUrl = (version, file) => `${CDN}/archives/mysql-${seriesOf(version)}/${file}`
const currentUrl = (version, file) => `${CDN}/Downloads/MySQL-${seriesOf(version)}/${file}`

/** The permanent archive URL when it exists, else the current-release one, else undefined. */
async function locate(version, file) {
  for (const url of [archiveUrl(version, file), currentUrl(version, file)]) {
    if ((await probe(url)).ok) return url
  }
  return undefined
}

const windowsFile = (version) => `mysql-${version}-winx64.zip`

/** Newest patch of a series, probing upward until `missesBeforeStop` patches in a row are absent. */
async function newestPatch(series, { maxPatch, missesBeforeStop }) {
  let newest
  let misses = 0
  for (let start = 0; start <= maxPatch && misses < missesBeforeStop; start += PROBE_CONCURRENCY) {
    const patches = Array.from({ length: PROBE_CONCURRENCY }, (_, i) => start + i).filter((p) => p <= maxPatch)
    const found = await mapPool(patches, PROBE_CONCURRENCY, async (p) => Boolean(await locate(`${series}.${p}`, windowsFile(`${series}.${p}`))))
    for (const [i, ok] of found.entries()) {
      if (ok) {
        newest = `${series}.${patches[i]}`
        misses = 0
      } else if (newest) {
        misses++
      }
    }
  }
  return newest
}

/** Newest innovation release (9.x), walking minors up from the configured first one. */
async function newestInnovation({ major, firstMinor }, probeConfig) {
  let newest
  let emptyMinors = 0
  for (let minor = firstMinor; emptyMinors < 2; minor++) {
    const found = await newestPatch(`${major}.${minor}`, { ...probeConfig, maxPatch: Math.min(probeConfig.maxPatch, 9), missesBeforeStop: 3 })
    if (found) {
      newest = found
      emptyMinors = 0
    } else {
      emptyMinors++
    }
  }
  return newest
}

/** The oldest macOS a version ships for, which is the widest-compatible download. */
async function macosBuild(version, arch, suffixes) {
  for (const suffix of suffixes) {
    const url = await locate(version, `mysql-${version}-${suffix}-${arch}.tar.gz`)
    if (url) return { url, minOsVersion: `${suffix.replace('macos', '')}.0` }
  }
  return undefined
}

const MAC_ARCH = { 'darwin-arm64': 'arm64', 'darwin-x64': 'x86_64' }

/** One platform's archive for a version, or undefined when MySQL did not ship it. */
async function platformBuild(version, platform, config) {
  const common = { stripComponents: 1, binDir: 'bin', license: config.license }
  if (platform === 'win32-x64') {
    const url = await locate(version, windowsFile(version))
    return url ? { url, format: 'zip', ...common } : undefined
  }
  const found = await macosBuild(version, MAC_ARCH[platform], config.macosSuffixes)
  return found ? { url: found.url, format: 'tar.gz', ...common, minOsVersion: found.minOsVersion } : undefined
}

/**
 * The newest patch for every platform. When the newest patch skips a platform (8.4.12
 * dropped Intel macOS), the newest older patch that has it becomes an extra entry.
 */
async function buildsFor(version, series, config) {
  const byVersion = new Map()
  const [major, minor, patch] = version.split('.').map(Number)
  let missing = ['darwin-arm64', 'darwin-x64', 'win32-x64']
  for (let p = patch; p >= Math.max(0, patch - config.patchProbe.fallbackPatches) && missing.length > 0; p--) {
    const candidate = `${major}.${minor}.${p}`
    const found = {}
    for (const platform of missing) {
      const build = await platformBuild(candidate, platform, config)
      if (build) found[platform] = build
    }
    if (Object.keys(found).length > 0) byVersion.set(candidate, found)
    missing = missing.filter((platform) => !found[platform])
  }
  return [...byVersion].map(([v, platforms]) => ({ version: v, major, series, platforms }))
}

export async function mysqlCandidates(config) {
  const versions = []
  for (const series of config.series) {
    const version = await newestPatch(series, config.patchProbe)
    if (!version) throw new Error(`MySQL ${series}: no release found on ${CDN}`)
    versions.push(...(await buildsFor(version, series, config)))
  }
  if (config.innovation) {
    const version = await newestInnovation(config.innovation, config.patchProbe)
    if (version && !config.series.includes(seriesOf(version))) versions.push(...(await buildsFor(version, seriesOf(version), config)))
  }
  return versions
}
