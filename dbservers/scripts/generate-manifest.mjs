#!/usr/bin/env node
// Builds manifest.json from the upstream sources listed in sources.json. It does not sign:
// run verify-manifest.mjs --no-signature, then sign-manifest.mjs.
//
//   node dbservers/scripts/generate-manifest.mjs                       all engines
//   node dbservers/scripts/generate-manifest.mjs --engine mongodb --engine mysql
//
// Engines not selected, or with no build yet, keep their entry from the previous manifest.
// A build whose URL is unchanged keeps its sha256 and size instead of being re-downloaded;
// verify-manifest.mjs re-downloads everything anyway.
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { downloadAndHash, mapPool, probe } from './lib/download.mjs'
import { DEFAULT_MANIFEST_PATH, ENGINES, MANIFEST_SCHEMA, SOURCES_PATH, compareVersions, listBuilds, readJson, serializeManifest, validateManifest } from './lib/manifest.mjs'
import { mongodbCandidates } from './lib/sources/mongodb.mjs'
import { mysqlCandidates } from './lib/sources/mysql.mjs'
import { postgresqlCandidates, valkeyCandidates } from './lib/sources/own-releases.mjs'

const DEFAULT_CONCURRENCY = 3

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: DEFAULT_MANIFEST_PATH },
    previous: { type: 'string', default: DEFAULT_MANIFEST_PATH },
    sources: { type: 'string', default: SOURCES_PATH },
    engine: { type: 'string', multiple: true },
    concurrency: { type: 'string', default: String(DEFAULT_CONCURRENCY) },
  },
})

const sources = await readJson(values.sources)
const previous = existsSync(values.previous) ? await readJson(values.previous) : undefined
const knownByUrl = new Map(previous ? listBuilds(previous).map(({ build }) => [build.url, build]) : [])
const selected = values.engine ?? ENGINES
for (const engine of selected) if (!ENGINES.includes(engine)) throw new Error(`unknown engine ${engine}`)

const CANDIDATES = {
  postgresql: (config) => postgresqlCandidates(config, sources.repository),
  mysql: (config) => mysqlCandidates(config),
  valkey: (config) => valkeyCandidates(config, sources.repository),
  mongodb: (config) => mongodbCandidates(config),
}

/** Fill sha256 and sizeBytes: reuse a known build, ask the server, or download. */
async function complete(engine, version, platform, build) {
  const label = `${engine} ${version} ${platform}`
  const known = knownByUrl.get(build.url)
  if (known && (!build.sha256 || build.sha256 === known.sha256)) return { ...build, sha256: known.sha256, sizeBytes: known.sizeBytes }
  if (build.sha256 && build.sizeBytes) return build
  if (build.sha256) {
    const { sizeBytes } = await probe(build.url)
    if (sizeBytes) return { ...build, sizeBytes }
  }
  console.log(`hash ${label} ${build.url}`)
  const hashed = await downloadAndHash(build.url)
  if (build.sha256 && build.sha256 !== hashed.sha256) throw new Error(`${label}: upstream sha256 ${build.sha256} but the download hashes to ${hashed.sha256}`)
  return { ...build, ...hashed }
}

/** Key order the daemon and humans read: identity, integrity, then layout. */
function orderBuild(build) {
  const { url, sha256, sizeBytes, format, stripComponents, binDir, minOsVersion, license } = build
  return { url, sha256, sizeBytes, format, stripComponents, binDir, ...(minOsVersion ? { minOsVersion } : {}), license }
}

async function engineEntry(engine) {
  const config = sources.engines[engine]
  const candidates = (await CANDIDATES[engine](config)).filter((c) => Object.keys(c.platforms).length > 0)
  if (candidates.length === 0) return undefined
  const jobs = candidates.flatMap((c) => Object.entries(c.platforms).map(([platform, build]) => ({ c, platform, build })))
  await mapPool(jobs, Number(values.concurrency), async ({ c, platform, build }) => {
    c.platforms[platform] = orderBuild(await complete(engine, c.version, platform, build))
  })
  candidates.sort((a, b) => compareVersions(b.version, a.version))
  const preferred = candidates.find((c) => c.series === config.defaultSeries) ?? candidates[0]
  return {
    defaultVersion: preferred.version,
    versions: candidates.map(({ version, major, platforms }) => ({ version, major, platforms })),
  }
}

const engines = {}
for (const engine of ENGINES) {
  const fresh = selected.includes(engine) ? await engineEntry(engine) : undefined
  const entry = fresh ?? previous?.engines?.[engine]
  if (!fresh && selected.includes(engine)) console.log(`skip ${engine}: no build published yet${entry ? ', kept the previous entry' : ''}`)
  if (entry) engines[engine] = entry
}

const manifest = { schema: MANIFEST_SCHEMA, generatedAt: new Date().toISOString(), engines }
const errors = validateManifest(manifest)
if (errors.length > 0) {
  console.error(`Generated manifest is invalid:\n  ${errors.join('\n  ')}`)
  process.exit(1)
}

// Rewriting only generatedAt would churn the signature and open an empty PR every week.
const sameContent = previous && resolve(values.out) === resolve(values.previous) && JSON.stringify(previous.engines) === JSON.stringify(engines)
if (sameContent) {
  console.log('no change: manifest left as it was')
} else {
  await writeFile(values.out, serializeManifest(manifest))
  console.log(`wrote ${values.out}: ${listBuilds(manifest).length} builds`)
}
