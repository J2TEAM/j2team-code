// Shape of manifest.json, checked by hand so the scripts need no npm install.
// Keep in step with ../../manifest.schema.json and the daemon's zod schema.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const MANIFEST_SCHEMA = 1
export const ENGINES = ['postgresql', 'mysql', 'valkey', 'mongodb']
export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64']
export const FORMATS = ['tar.gz', 'tar.xz', 'zip']

/** Binaries that must sit in binDir once extracted (".exe" added on Windows). */
export const REQUIRED_BINARIES = {
  postgresql: ['postgres', 'initdb', 'pg_ctl'],
  mysql: ['mysqld'],
  valkey: ['valkey-server', 'valkey-cli'],
  mongodb: ['mongod'],
}

export const DBSERVERS_DIR = fileURLToPath(new URL('../../', import.meta.url))
export const DEFAULT_MANIFEST_PATH = `${DBSERVERS_DIR}manifest.json`
export const DEFAULT_SIGNATURE_PATH = `${DEFAULT_MANIFEST_PATH}.sig`
export const DEFAULT_PUBLIC_KEY_PATH = `${DBSERVERS_DIR}manifest-public-key.pem`
export const SOURCES_PATH = `${DBSERVERS_DIR}sources.json`

/** The exact bytes written for a manifest: two-space JSON and a final newline. */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function checkKeys(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown key "${key}"`)
  }
}

function validateBuild(build, where, errors) {
  if (!isObject(build)) return errors.push(`${where}: not an object`)
  const keys = ['url', 'sha256', 'sizeBytes', 'format', 'stripComponents', 'binDir', 'minOsVersion', 'license']
  checkKeys(build, keys, where, errors)
  if (typeof build.url !== 'string' || !build.url.startsWith('https://')) errors.push(`${where}.url: must be https`)
  if (typeof build.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(build.sha256)) errors.push(`${where}.sha256: not a lowercase hex sha256`)
  if (!Number.isInteger(build.sizeBytes) || build.sizeBytes < 1) errors.push(`${where}.sizeBytes: not a positive integer`)
  if (!FORMATS.includes(build.format)) errors.push(`${where}.format: not one of ${FORMATS.join(', ')}`)
  if (!Number.isInteger(build.stripComponents) || build.stripComponents < 0) errors.push(`${where}.stripComponents: not a non-negative integer`)
  if (typeof build.binDir !== 'string' || build.binDir === '' || build.binDir.startsWith('/') || build.binDir.split('/').includes('..') || build.binDir.includes('\\')) {
    errors.push(`${where}.binDir: must be a relative forward-slash path without ".."`)
  }
  if (build.minOsVersion !== undefined && !/^\d+\.\d+$/.test(build.minOsVersion)) errors.push(`${where}.minOsVersion: must be major.minor`)
  if (typeof build.license !== 'string' || build.license === '') errors.push(`${where}.license: missing`)
}

/** Returns a list of problems; an empty list means the manifest is valid. */
export function validateManifest(manifest) {
  const errors = []
  if (!isObject(manifest)) return ['manifest: not an object']
  checkKeys(manifest, ['schema', 'generatedAt', 'engines'], 'manifest', errors)
  if (manifest.schema !== MANIFEST_SCHEMA) errors.push(`schema: must be ${MANIFEST_SCHEMA}`)
  if (typeof manifest.generatedAt !== 'string' || Number.isNaN(Date.parse(manifest.generatedAt))) errors.push('generatedAt: not a date-time')
  if (!isObject(manifest.engines) || Object.keys(manifest.engines).length === 0) {
    errors.push('engines: must hold at least one engine')
    return errors
  }
  checkKeys(manifest.engines, ENGINES, 'engines', errors)
  for (const [name, engine] of Object.entries(manifest.engines)) {
    const where = `engines.${name}`
    if (!isObject(engine)) {
      errors.push(`${where}: not an object`)
      continue
    }
    checkKeys(engine, ['defaultVersion', 'versions'], where, errors)
    if (!Array.isArray(engine.versions) || engine.versions.length === 0) {
      errors.push(`${where}.versions: must be a non-empty array`)
      continue
    }
    const seen = new Set()
    engine.versions.forEach((entry, i) => {
      const at = `${where}.versions[${i}]`
      if (!isObject(entry)) return errors.push(`${at}: not an object`)
      checkKeys(entry, ['version', 'major', 'platforms'], at, errors)
      if (typeof entry.version !== 'string' || !/^\d+(\.\d+){1,2}$/.test(entry.version)) errors.push(`${at}.version: not a dotted version`)
      if (seen.has(entry.version)) errors.push(`${at}.version: duplicate ${entry.version}`)
      seen.add(entry.version)
      if (!Number.isInteger(entry.major) || entry.major < 1) errors.push(`${at}.major: not a positive integer`)
      else if (typeof entry.version === 'string' && Number(entry.version.split('.')[0]) !== entry.major) errors.push(`${at}.major: does not match version`)
      if (!isObject(entry.platforms) || Object.keys(entry.platforms).length === 0) return errors.push(`${at}.platforms: must hold at least one platform`)
      checkKeys(entry.platforms, PLATFORMS, `${at}.platforms`, errors)
      for (const [platform, build] of Object.entries(entry.platforms)) validateBuild(build, `${at}.platforms.${platform}`, errors)
    })
    if (!seen.has(engine.defaultVersion)) errors.push(`${where}.defaultVersion: "${engine.defaultVersion}" is not in versions`)
  }
  return errors
}

/** Every build in the manifest, flattened, for the verify and refresh loops. */
export function listBuilds(manifest) {
  const builds = []
  for (const [engine, { versions }] of Object.entries(manifest.engines)) {
    for (const { version, platforms } of versions) {
      for (const [platform, build] of Object.entries(platforms)) builds.push({ engine, version, platform, build })
    }
  }
  return builds
}

/** Numeric compare of dotted versions, for newest-first sorting. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
