// MongoDB Community: official fastdl.mongodb.org archives and the sha256 MongoDB publishes
// in current.json. Linked only, never re-hosted (SSPL).
import { fetchJson } from '../download.mjs'
import { compareVersions } from '../manifest.mjs'

const CURRENT_JSON_URL = 'https://downloads.mongodb.org/current.json'

const PLATFORM_OF = {
  'macos/arm64': 'darwin-arm64',
  'macos/x86_64': 'darwin-x64',
  'windows/x86_64': 'win32-x64',
}

function formatOf(url) {
  if (url.endsWith('.tgz') || url.endsWith('.tar.gz')) return 'tar.gz'
  if (url.endsWith('.zip')) return 'zip'
  throw new Error(`unknown MongoDB archive format: ${url}`)
}

/** Candidate builds (url + sha256, size still to fill) for each configured series. */
export async function mongodbCandidates(config) {
  const current = await fetchJson(CURRENT_JSON_URL)
  const versions = []
  for (const series of config.series) {
    const release = current.versions
      .filter((v) => v.production_release && v.version.startsWith(`${series}.`) && /^\d+\.\d+\.\d+$/.test(v.version))
      .sort((a, b) => compareVersions(b.version, a.version))[0]
    if (!release) throw new Error(`MongoDB ${series}: no production release in current.json`)
    const platforms = {}
    for (const download of release.downloads) {
      const platform = PLATFORM_OF[`${download.target}/${download.arch}`]
      if (!platform || download.edition !== 'base' || !download.archive?.url) continue
      platforms[platform] = {
        url: download.archive.url,
        sha256: download.archive.sha256.toLowerCase(),
        format: formatOf(download.archive.url),
        stripComponents: 1,
        binDir: 'bin',
        license: config.license,
      }
    }
    versions.push({ version: release.version, major: Number(release.version.split('.')[0]), series, platforms })
  }
  return versions
}
