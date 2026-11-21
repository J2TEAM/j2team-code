// Lists an archive the way the daemon extracts it (`tar -xf --strip-components`), so a
// wrong stripComponents or binDir fails here instead of on a user's machine.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { REQUIRED_BINARIES } from './manifest.mjs'

const run = promisify(execFile)
const LIST_MAX_BUFFER = 256 * 1024 * 1024

let tarCommand
/** bsdtar reads zip as well as tar; GNU tar (Linux runners) does not. */
async function findTar() {
  if (tarCommand) return tarCommand
  for (const candidate of ['bsdtar', 'tar']) {
    try {
      const { stdout } = await run(candidate, ['--version'])
      if (stdout.includes('bsdtar') || stdout.includes('libarchive')) return (tarCommand = candidate)
    } catch {
      // try the next one
    }
  }
  throw new Error('No bsdtar found: install libarchive-tools (apt) or run on macOS/Windows')
}

export async function listEntries(archivePath) {
  const tar = await findTar()
  const { stdout } = await run(tar, ['-tf', archivePath], { maxBuffer: LIST_MAX_BUFFER })
  return stdout.split('\n').filter(Boolean)
}

/** Problems with the extracted layout; an empty list means binDir holds every binary. */
export async function checkLayout(archivePath, { engine, platform, build }) {
  const entries = await listEntries(archivePath)
  const stripped = new Set()
  for (const entry of entries) {
    const parts = entry.replace(/\\/g, '/').split('/').filter(Boolean)
    if (parts.length > build.stripComponents) stripped.add(parts.slice(build.stripComponents).join('/'))
  }
  const suffix = platform.startsWith('win32') ? '.exe' : ''
  return REQUIRED_BINARIES[engine]
    .map((name) => `${build.binDir}/${name}${suffix}`)
    .filter((path) => !stripped.has(path))
    .map((path) => `missing ${path} after --strip-components=${build.stripComponents}`)
}
