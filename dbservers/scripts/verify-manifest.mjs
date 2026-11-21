#!/usr/bin/env node
// Checks manifest.json the way a daemon would, and harder: the shape, the ed25519
// signature, then every archive re-downloaded for its sha256, size and extracted layout.
//
//   node dbservers/scripts/verify-manifest.mjs                     everything
//   node dbservers/scripts/verify-manifest.mjs --no-signature      before signing (CI)
//   node dbservers/scripts/verify-manifest.mjs --no-download       signature and shape only
//   node dbservers/scripts/verify-manifest.mjs --engine mysql      one engine's archives
//
// The public key comes from --public-key (a file), $MANIFEST_PUBLIC_KEY, or
// dbservers/manifest-public-key.pem.
import { verify } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { checkLayout } from './lib/archive.mjs'
import { downloadAndHash, mapPool } from './lib/download.mjs'
import { parsePublicKey } from './lib/keys.mjs'
import { DEFAULT_MANIFEST_PATH, DEFAULT_PUBLIC_KEY_PATH, ENGINES, listBuilds, validateManifest } from './lib/manifest.mjs'

const DEFAULT_CONCURRENCY = 3

const { values } = parseArgs({
  options: {
    manifest: { type: 'string', default: DEFAULT_MANIFEST_PATH },
    sig: { type: 'string' },
    'public-key': { type: 'string' },
    signature: { type: 'boolean', default: true },
    download: { type: 'boolean', default: true },
    layout: { type: 'boolean', default: true },
    engine: { type: 'string', multiple: true },
    concurrency: { type: 'string', default: String(DEFAULT_CONCURRENCY) },
  },
  allowNegative: true,
})

for (const engine of values.engine ?? []) {
  if (!ENGINES.includes(engine)) {
    console.error(`unknown engine "${engine}" (one of ${ENGINES.join(', ')})`)
    process.exit(2)
  }
}

const failures = []
const fail = (message) => {
  failures.push(message)
  console.error(`FAIL ${message}`)
}

const bytes = await readFile(values.manifest)
const manifest = JSON.parse(bytes.toString('utf8'))
const shapeErrors = validateManifest(manifest)
for (const error of shapeErrors) fail(`shape: ${error}`)
if (shapeErrors.length === 0) console.log(`ok   shape (${listBuilds(manifest).length} builds)`)

async function loadPublicKey() {
  if (values['public-key']) return parsePublicKey(await readFile(values['public-key'], 'utf8'))
  if (process.env.MANIFEST_PUBLIC_KEY) return parsePublicKey(process.env.MANIFEST_PUBLIC_KEY)
  if (existsSync(DEFAULT_PUBLIC_KEY_PATH)) return parsePublicKey(await readFile(DEFAULT_PUBLIC_KEY_PATH, 'utf8'))
  throw new Error('no public key: pass --public-key, set MANIFEST_PUBLIC_KEY, or commit dbservers/manifest-public-key.pem')
}

if (values.signature) {
  const sigPath = values.sig ?? `${values.manifest}.sig`
  try {
    const signature = Buffer.from((await readFile(sigPath, 'utf8')).trim(), 'base64')
    if (verify(null, bytes, await loadPublicKey(), signature)) console.log(`ok   signature ${sigPath}`)
    else fail(`signature: ${sigPath} does not match the manifest bytes`)
  } catch (error) {
    fail(`signature: ${error.message}`)
  }
}

if (values.download && shapeErrors.length === 0) {
  const builds = listBuilds(manifest).filter((b) => !values.engine || values.engine.includes(b.engine))
  const workDir = await mkdtemp(join(tmpdir(), 'dbservers-verify-'))
  try {
    await mapPool(builds, Number(values.concurrency), async (item, index) => {
      const label = `${item.engine} ${item.version} ${item.platform}`
      const saveTo = values.layout ? join(workDir, `${index}.${item.build.format}`) : undefined
      try {
        const { sha256, sizeBytes } = await downloadAndHash(item.build.url, { saveTo })
        const problems = []
        if (sha256 !== item.build.sha256) problems.push(`sha256 ${sha256} != ${item.build.sha256}`)
        if (sizeBytes !== item.build.sizeBytes) problems.push(`size ${sizeBytes} != ${item.build.sizeBytes}`)
        if (saveTo && problems.length === 0) problems.push(...(await checkLayout(saveTo, item)))
        if (problems.length > 0) fail(`${label}: ${problems.join('; ')} (${item.build.url})`)
        else console.log(`ok   ${label} ${(sizeBytes / 1e6).toFixed(1)} MB`)
      } catch (error) {
        fail(`${label}: ${error.message}`)
      } finally {
        if (saveTo) await rm(saveTo, { force: true })
      }
    })
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s)`)
  process.exit(1)
}
console.log('\nmanifest verified')
