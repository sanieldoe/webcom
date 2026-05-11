/**
 * app/vault-tab.js
 *
 * Vault tab — file browser + editor.
 * Host:   reads/writes vault files directly via File System Access API.
 * Client: sends vault_list / vault_read / vault_write requests over the
 *         relay and waits for responses from the host.
 *
 * Registers itself with app.js via registerTab() and onData().
 */

import { registerTab, onData, S, set } from './app.js'
import { listDir, readFile, writeFile } from './vault.js'

// ── Module state ──────────────────────────────────────────────────────────────

let currentPath = ''      // current directory path ('' = vault root)
let entries     = []      // [{ name, kind, path }]
let openFile    = null    // { path, content } | null
let loading     = false
let errMsg      = null

// Pending client requests: id → { resolve, reject, timer }
const pending = new Map()
let reqId = 0

// ── Re-render helper ──────────────────────────────────────────────────────────

function rerender() { set({}) }

// ── File operations ──────────────────────────────────────────────────────────

async function doListDir(path) {
  loading = true; errMsg = null; rerender()
  try {
    entries = S.role === 'host'
      ? await listDir(S.vault, path)
      : (await vaultRequest('vault_list', { path })).entries
    currentPath = path
    openFile    = null
  } catch (e) {
    errMsg = e.message
  } finally {
    loading = false; rerender()
  }
}

async function doReadFile(path) {
  loading = true; errMsg = null; rerender()
  try {
    const content = S.role === 'host'
      ? await readFile(S.vault, path)
      : (await vaultRequest('vault_read', { path })).content
    openFile = { path, content }
  } catch (e) {
    errMsg = e.message
  } finally {
    loading = false; rerender()
  }
}

async function doWriteFile(path, content) {
  // Update content in state before triggering re-render so the textarea
  // value is preserved across the loading state.
  openFile = { path, content }
  loading  = true; errMsg = null; rerender()
  try {
    if (S.role === 'host') {
      await writeFile(S.vault, path, content)
    } else {
      await vaultRequest('vault_write', { path, content })
    }
  } catch (e) {
    errMsg = e.message
  } finally {
    loading = false; rerender()
  }
}

// ── Client request/response ────────────────────────────────────────────────

function vaultRequest(type, data, timeoutMs = 15_000) {
  const id = `v${++reqId}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Request timed out — is host online?'))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    S.relay.send({ id, type, ...data })
  })
}

function handleResponse(msg) {
  const p = pending.get(msg.id)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(msg.id)
  msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg)
}

onData('client', 'vault_list_response',  handleResponse)
onData('client', 'vault_read_response',  handleResponse)
onData('client', 'vault_write_response', handleResponse)

// ── Host request handlers ─────────────────────────────────────────────────

async function handleVaultList(msg) {
  try {
    const es = await listDir(S.vault, msg.path ?? '')
    S.relay.send({ id: msg.id, type: 'vault_list_response', entries: es })
  } catch (e) {
    S.relay.send({ id: msg.id, type: 'vault_list_response', error: e.message, entries: [] })
  }
}

async function handleVaultRead(msg) {
  try {
    const content = await readFile(S.vault, msg.path)
    S.relay.send({ id: msg.id, type: 'vault_read_response', content })
  } catch (e) {
    S.relay.send({ id: msg.id, type: 'vault_read_response', error: e.message, content: '' })
  }
}

async function handleVaultWrite(msg) {
  try {
    await writeFile(S.vault, msg.path, msg.content)
    S.relay.send({ id: msg.id, type: 'vault_write_response', ok: true })
  } catch (e) {
    S.relay.send({ id: msg.id, type: 'vault_write_response', error: e.message, ok: false })
  }
}

onData('host', 'vault_list',  handleVaultList)
onData('host', 'vault_read',  handleVaultRead)
onData('host', 'vault_write', handleVaultWrite)

// ── Event delegation ──────────────────────────────────────────────────────

document.getElementById('root').addEventListener('click', e => {
  const el = e.target.closest('[data-vault-action]')
  if (!el) return
  const action = el.dataset.vaultAction
  const path   = el.dataset.vaultPath ?? ''

  if (action === 'cd')           doListDir(path)
  if (action === 'open')         doReadFile(path)
  if (action === 'close-editor') { openFile = null; rerender() }
  if (action === 'save') {
    const content = document.getElementById('vault-editor')?.value ?? openFile?.content ?? ''
    doWriteFile(openFile.path, content)
  }
})

// ── Tab registration ──────────────────────────────────────────────────────

registerTab('vault', () => {
  // Trigger initial directory load after this render cycle completes
  if (!loading && !openFile && entries.length === 0 && !errMsg) {
    setTimeout(() => doListDir(currentPath), 0)
  }
  return renderVault()
})

// ── Render ────────────────────────────────────────────────────────────────

function renderVault() {
  if (S.role === 'client' && !S.connected) {
    return `<div class="placeholder">
      <div class="placeholder-icon">📁</div>
      <p class="placeholder-title">Vault</p>
      <p class="placeholder-sub">Host is offline</p>
    </div>`
  }

  if (openFile) return renderEditor()

  return `<div class="vault-wrap">
    ${renderBreadcrumb()}
    ${errMsg ? `<p class="error vault-error">${esc(errMsg)}</p>` : ''}
    ${loading
      ? `<div class="vault-loading"><div class="spinner"></div></div>`
      : renderBrowser()}
  </div>`
}

function renderBreadcrumb() {
  const parts  = currentPath ? currentPath.split('/') : []
  const crumbs = [{ label: 'vault', path: '' }]
  parts.forEach((p, i) => crumbs.push({ label: p, path: parts.slice(0, i + 1).join('/') }))

  return `<div class="vault-breadcrumb">
    ${crumbs.map((c, i) =>
      i < crumbs.length - 1
        ? `<button class="vault-crumb-btn" data-vault-action="cd" data-vault-path="${esc(c.path)}">${esc(c.label)}</button><span class="vault-sep">›</span>`
        : `<span class="vault-crumb-cur">${esc(c.label)}</span>`
    ).join('')}
  </div>`
}

function renderBrowser() {
  if (entries.length === 0) {
    return `<p class="vault-empty">Empty folder</p>`
  }
  return `<div class="vault-list">
    ${entries.map(e => `
      <button class="vault-entry"
        data-vault-action="${e.kind === 'directory' ? 'cd' : 'open'}"
        data-vault-path="${esc(e.path)}">
        <span class="vault-entry-icon">${e.kind === 'directory' ? '📁' : fileIcon(e.name)}</span>
        <span class="vault-entry-name">${esc(e.name)}</span>
        ${e.kind === 'directory' ? '<span class="vault-entry-arrow">›</span>' : ''}
      </button>`).join('')}
  </div>`
}

function renderEditor() {
  const filename = openFile.path.split('/').pop()
  return `<div class="vault-editor-wrap">
    <div class="vault-editor-header">
      <button class="btn btn-ghost btn-sm" data-vault-action="close-editor" ${loading ? 'disabled' : ''}>← Back</button>
      <span class="vault-editor-filename">${esc(filename)}</span>
      <button class="btn btn-primary btn-sm" data-vault-action="save" ${loading ? 'disabled' : ''}>
        ${loading ? 'Saving…' : 'Save'}
      </button>
    </div>
    ${errMsg ? `<p class="error vault-error">${esc(errMsg)}</p>` : ''}
    <textarea class="vault-editor" id="vault-editor"
      placeholder="Empty file" spellcheck="false">${esc(openFile.content)}</textarea>
  </div>`
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fileIcon(name) {
  if (name.endsWith('.md'))   return '📝'
  if (name.endsWith('.html')) return '🌐'
  if (name.endsWith('.js'))   return '📜'
  if (name.endsWith('.json')) return '📋'
  if (name.endsWith('.css'))  return '🎨'
  return '📄'
}

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
