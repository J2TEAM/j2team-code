#!/usr/bin/env node
// Prints a fresh ed25519 key pair for signing manifest.json. Nothing private touches disk:
// paste the private key into the MANIFEST_SIGNING_KEY secret and clear your terminal.
//
//   node dbservers/scripts/keygen.mjs                 print both keys
//   node dbservers/scripts/keygen.mjs --write-public  also write dbservers/manifest-public-key.pem
import { generateKeyPairSync } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { DEFAULT_PUBLIC_KEY_PATH } from './lib/manifest.mjs'
import { publicKeyBase64 } from './lib/keys.mjs'

const { values } = parseArgs({ options: { 'write-public': { type: 'boolean', default: false } } })

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' })
const publicPem = publicKey.export({ format: 'pem', type: 'spki' })
const raw = publicKey.export({ format: 'jwk' }).x

process.stdout.write(`# PRIVATE KEY (PKCS8 PEM): GitHub secret MANIFEST_SIGNING_KEY. Never commit it.
${privatePem}
# PUBLIC KEY (SPKI PEM): dbservers/manifest-public-key.pem
${publicPem}
# PUBLIC KEY, one line (base64 SPKI DER): embed this in the daemon
${publicKeyBase64(publicKey)}

# PUBLIC KEY, raw 32 bytes (base64url, JWK "x"), for reference
${raw}
`)

if (values['write-public']) {
  await writeFile(DEFAULT_PUBLIC_KEY_PATH, publicPem)
  process.stderr.write(`wrote ${DEFAULT_PUBLIC_KEY_PATH}\n`)
}
