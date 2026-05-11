/**
 * app/vault.js
 *
 * File System Access API helpers for the vault.
 * Runs on the host only — these functions are called either directly
 * (host UI) or in response to relay messages from a client.
 */

const REQUIRED = ['Journal', 'Projects', 'Raw', 'Wiki']  // sorted

export async function validateOrInitVault(root) {
  // list non-hidden entries at root
  const entries = []
  for await (const [name, handle] of root.entries()) {
    if (!name.startsWith('.')) entries.push({ name, kind: handle.kind })
  }

  if (entries.length === 0) {
    // empty — create the 4 folders
    for (const name of REQUIRED) {
      await root.getDirectoryHandle(name, { create: true })
    }
    return { ok: true, created: true }
  }

  // check that entries are exactly the 4 required directories
  const names = entries.map(e => e.name).sort()
  const allDirs = entries.every(e => e.kind === 'directory')
  const exact = names.length === 4 && names.every((n, i) => n === REQUIRED[i])

  if (allDirs && exact) return { ok: true }

  return {
    ok: false,
    error: 'This folder doesn\'t look like a Companions vault. Select an empty folder to create a new vault, or choose an existing one with the Projects, Raw, Wiki and Journal folders.'
  }
}

// Navigate to a directory handle by path string (e.g. "projects/inbox")
async function walkToDir(root, path, { create = false } = {}) {
  if (!path) return root
  let dir = root
  for (const part of path.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create })
  }
  return dir
}

// Navigate to a file handle by path string (e.g. "journal/2026-05-11.md")
async function walkToFile(root, path, { create = false } = {}) {
  const parts  = path.split('/').filter(Boolean)
  const name   = parts.pop()
  const dir    = await walkToDir(root, parts.join('/'), { create })
  return dir.getFileHandle(name, { create })
}

/**
 * List entries in a directory.
 * Returns [{ name, kind, path }], directories first, then files, both sorted.
 */
export async function listDir(root, path = '') {
  const dir     = await walkToDir(root, path)
  const entries = []
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.')) continue
    entries.push({ name, kind: handle.kind, path: path ? `${path}/${name}` : name })
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

/** Read a file's text content. */
export async function readFile(root, path) {
  const handle = await walkToFile(root, path)
  const file   = await handle.getFile()
  return file.text()
}

/** Write (or create) a file with text content. */
export async function writeFile(root, path, content) {
  const handle   = await walkToFile(root, path, { create: true })
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
}
