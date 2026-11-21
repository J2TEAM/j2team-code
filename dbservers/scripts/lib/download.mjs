// Network helpers shared by the generator and the verifier: HEAD probes, a hashing
// download that never holds a whole archive in memory, and a small concurrency pool.
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const USER_AGENT = 'j2team-code-dbservers-scripts'
const RETRIES = 3
const RETRY_DELAY_MS = 2000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithRetry(url, init = {}) {
  let lastError
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow', ...init, headers: { 'user-agent': USER_AGENT, ...init.headers } })
      // 404 is an answer (a probe miss), not a reason to retry.
      if (response.ok || response.status === 404 || response.status === 403) return response
      lastError = new Error(`${response.status} ${response.statusText} for ${url}`)
      await response.body?.cancel()
    } catch (error) {
      lastError = error
    }
    if (attempt < RETRIES) await sleep(RETRY_DELAY_MS * attempt)
  }
  throw lastError
}

/** HEAD a URL: whether it exists and its Content-Length when the server sends one. */
export async function probe(url) {
  const response = await fetchWithRetry(url, { method: 'HEAD' })
  const length = Number(response.headers.get('content-length'))
  return { ok: response.ok, sizeBytes: Number.isFinite(length) && length > 0 ? length : undefined }
}

export async function fetchText(url, headers = {}) {
  const response = await fetchWithRetry(url, { headers })
  if (!response.ok) throw new Error(`${response.status} for ${url}`)
  return response.text()
}

export async function fetchJson(url, headers = {}) {
  return JSON.parse(await fetchText(url, headers))
}

/**
 * Stream a URL through sha256, optionally saving it to `saveTo`.
 * Returns the hex digest and the byte count actually received.
 */
export async function downloadAndHash(url, { saveTo } = {}) {
  const response = await fetchWithRetry(url)
  if (!response.ok || !response.body) throw new Error(`${response.status} for ${url}`)
  const hash = createHash('sha256')
  let sizeBytes = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      sizeBytes += chunk.length
      callback(null, saveTo ? chunk : undefined)
    },
  })
  const source = Readable.fromWeb(response.body)
  if (saveTo) await pipeline(source, meter, createWriteStream(saveTo))
  else await pipeline(source, meter, async (chunks) => {
    for await (const _ of chunks);
  })
  return { sha256: hash.digest('hex'), sizeBytes }
}

/** Run `fn` over `items` with at most `limit` running at once, keeping order. */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}
