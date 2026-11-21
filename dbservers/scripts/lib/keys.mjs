// Ed25519 key parsing shared by sign and verify. A public key may be SPKI PEM, base64 SPKI
// DER (the one-line form the daemon embeds) or base64 of the raw 32 bytes.
import { createPrivateKey, createPublicKey } from 'node:crypto'

// SPKI DER prefix for an Ed25519 key: SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING }.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const RAW_KEY_BYTES = 32

export function parsePublicKey(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('-----BEGIN')) return assertEd25519(createPublicKey(trimmed))
  const bytes = Buffer.from(trimmed, 'base64')
  const der = bytes.length === RAW_KEY_BYTES ? Buffer.concat([ED25519_SPKI_PREFIX, bytes]) : bytes
  return assertEd25519(createPublicKey({ key: der, format: 'der', type: 'spki' }))
}

export function parsePrivateKey(pem) {
  return assertEd25519(createPrivateKey(pem.trim()))
}

function assertEd25519(key) {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`expected an ed25519 key, got ${key.asymmetricKeyType}`)
  return key
}

/** The one-line base64 SPKI DER form, which is what the daemon embeds. */
export function publicKeyBase64(key) {
  return key.export({ format: 'der', type: 'spki' }).toString('base64')
}
