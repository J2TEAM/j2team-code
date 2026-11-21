#!/usr/bin/env node
// Writes manifest.json.sig: base64 ed25519 over the exact bytes of manifest.json.
// The private key comes from $MANIFEST_SIGNING_KEY (PKCS8 PEM) or --key-file.
//
//   MANIFEST_SIGNING_KEY="$(cat key.pem)" node dbservers/scripts/sign-manifest.mjs
import { createPublicKey, sign, verify } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { DEFAULT_MANIFEST_PATH, DEFAULT_PUBLIC_KEY_PATH, validateManifest } from './lib/manifest.mjs'
import { parsePrivateKey, parsePublicKey, publicKeyBase64 } from './lib/keys.mjs'

const { values } = parseArgs({
  options: {
    manifest: { type: 'string', default: DEFAULT_MANIFEST_PATH },
    out: { type: 'string' },
    'key-file': { type: 'string' },
    'public-key': { type: 'string', default: DEFAULT_PUBLIC_KEY_PATH },
  },
})

const keyPem = values['key-file'] ? await readFile(values['key-file'], 'utf8') : process.env.MANIFEST_SIGNING_KEY
if (!keyPem) {
  console.error('No signing key: set MANIFEST_SIGNING_KEY or pass --key-file')
  process.exit(1)
}
const privateKey = parsePrivateKey(keyPem)

const bytes = await readFile(values.manifest)
const errors = validateManifest(JSON.parse(bytes.toString('utf8')))
if (errors.length > 0) {
  console.error(`Refusing to sign an invalid manifest:\n  ${errors.join('\n  ')}`)
  process.exit(1)
}

// A secret that no longer matches the committed public key would ship a manifest every
// daemon rejects, so fail here instead.
const derivedPublic = createPublicKey(privateKey)
if (existsSync(values['public-key'])) {
  const committed = parsePublicKey(await readFile(values['public-key'], 'utf8'))
  if (publicKeyBase64(committed) !== publicKeyBase64(derivedPublic)) {
    console.error(`The signing key does not match ${values['public-key']}`)
    process.exit(1)
  }
}

const signature = sign(null, bytes, privateKey)
if (!verify(null, bytes, derivedPublic, signature)) throw new Error('fresh signature failed to verify')
const out = values.out ?? `${values.manifest}.sig`
await writeFile(out, signature.toString('base64'))
console.log(`signed ${values.manifest} -> ${out} (public key ${publicKeyBase64(derivedPublic)})`)
