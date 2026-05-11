/**
 * app/app.js
 *
 * Companions Lite — app shell
 * Handles: landing, host flow, client flow, session pairing, connected state.
 * Tab content (Today / Chat / Ruse / Vault) is stubbed here;
 * each step fills it in.
 */

import { RelayClient } from './relay-client.js'
import QRCode from 'https://esm.sh/qrcode@1.5.3'

// ── Config ────────────────────────────────────────────────────────────────────

// Relay runs on the same server as the static files (same host, same port).
// This works for localhost, local IPs, Tailscale, ngrok, and any tunnel.
// In production (Cloudflare Pages + Railway) the relay moves to a subdomain.
const RELAY_WS = (() => {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  // Production — relay is on Cloudflare Workers
  if (window.location.hostname === 'companions.aftrhrs.au') {
    return 'wss://webcom-relay.companions.workers.dev'
  }
  // Dev / ngrok / tunnel — relay is on the same server
  return `${proto}//${window.location.host}`
})()

const RELAY_HTTP = RELAY_WS.replace(/^ws/, 'http')

// QR / join URL — on localhost the Mac must advertise a reachable address.
// On any other origin (ngrok, IP, domain) just use window.location.origin.
const PHONE_ORIGIN = 'http://100.82.35.39:4000'  // ← Tailscale IP, used only when on localhost

const JOIN_ORIGIN = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? PHONE_ORIGIN
  : window.location.origin

// ── State ─────────────────────────────────────────────────────────────────────

const S = {
  screen:    'landing',   // landing | host-waiting | client-entry | client-connecting | app
  role:      null,        // 'host' | 'client'
  code:      null,        // session code string
  relay:     null,        // RelayClient instance
  vault:     null,        // FileSystemDirectoryHandle (host only)
  peers:     0,
  connected: false,
  tab:       'today',     // today | chat | ruse | vault
  error:     null,
  inputCode: '',          // client code input value
  copied:    false,       // copy-link feedback
  qrDataUrl: null,        // generated QR code data URL
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const root = document.getElementById('root')

function set(patch) {
  Object.assign(S, patch)
  render()
  afterRender()
}

function fmt(code) {
  // "ABCDEF" → "ABC · DEF"
  if (!code) return ''
  return code.slice(0, 3) + ' · ' + code.slice(3)
}

const hasFileApi = typeof window.showDirectoryPicker === 'function'

// ── Event delegation ──────────────────────────────────────────────────────────

root.addEventListener('click', e => {
  const el = e.target.closest('[data-action]')
  if (!el) return
  ACTIONS[el.dataset.action]?.(e, el)
})

root.addEventListener('input', e => {
  if (e.target.id === 'code-input') {
    const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
    e.target.value = v
    S.inputCode = v
  }
})

root.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'code-input') ACTIONS['connect-client']?.()
})

// ── Actions ───────────────────────────────────────────────────────────────────

const ACTIONS = {

  'open-host': async () => {
    if (!hasFileApi) {
      set({ error: 'Host mode requires Chrome or Edge on desktop.' }); return
    }
    // showDirectoryPicker must be called synchronously inside user gesture
    let vault
    try {
      vault = await window.showDirectoryPicker({ mode: 'readwrite' })
    } catch (e) {
      if (e.name !== 'AbortError') set({ error: 'Could not open vault folder.' })
      return
    }

    set({ screen: 'loading', vault, error: null })

    let code
    try {
      const res = await fetch(`${RELAY_HTTP}/session/create`, { method: 'POST' })
      if (!res.ok) throw new Error(`relay ${res.status}`)
      ;({ code } = await res.json())
    } catch {
      set({ screen: 'landing', error: 'Could not reach relay. Is it running?' }); return
    }

    localStorage.setItem('wc_code', code)
    localStorage.setItem('wc_role', 'host')

    const relay = new RelayClient(RELAY_WS, code, 'host')
    relay.on('control', msg => onRelayControl(msg))
    relay.on('data',    msg => onHostData(msg))
    await relay.connect()

    set({ screen: 'host-waiting', role: 'host', code, relay, peers: 0, error: null, qrDataUrl: null })
    generateQR(code)
  },

  'open-client': () => {
    const pre = new URLSearchParams(window.location.search).get('join') || ''
    set({ screen: 'client-entry', inputCode: pre.toUpperCase(), error: null })
  },

  'connect-client': async () => {
    const code = S.inputCode.trim().toUpperCase()
    if (code.length !== 6) { set({ error: 'Code must be 6 characters.' }); return }

    set({ screen: 'client-connecting', code, role: 'client', error: null })

    const relay = new RelayClient(RELAY_WS, code, 'client')

    // If not connected within 12 seconds, show an error
    const timeout = setTimeout(() => {
      if (S.screen === 'client-connecting') {
        relay.disconnect()
        set({
          screen: 'client-entry',
          role: null,
          error: `Could not reach relay at ${RELAY_WS} — check that both devices can reach this address`,
        })
      }
    }, 12_000)

    relay.on('control', msg => {
      if (msg.type === 'joined') clearTimeout(timeout)
      onRelayControl(msg)
    })
    relay.on('data', msg => onClientData(msg))
    await relay.connect()

    localStorage.setItem('wc_code', code)
    localStorage.setItem('wc_role', 'client')
    S.relay = relay
  },

  'back': () => {
    S.relay?.disconnect()
    set({ screen: 'landing', relay: null, code: null, error: null, peers: 0 })
    // Clear ?join= param from URL without reload
    window.history.replaceState({}, '', window.location.pathname)
  },

  'copy-link': async (_, el) => {
    const url = `${JOIN_ORIGIN}?join=${S.code}`
    try {
      await navigator.clipboard.writeText(url)
      set({ copied: true })
      setTimeout(() => set({ copied: false }), 2000)
    } catch { /* clipboard blocked */ }
  },

  'switch-tab': (_, el) => {
    set({ tab: el.dataset.tab })
  },
}

// ── Relay event handlers ──────────────────────────────────────────────────────

function onRelayControl(msg) {
  console.log('[relay control]', msg.type, msg)
  switch (msg.type) {

    case 'joined':
      if (S.role === 'host') {
        // Already set screen in open-host; update peers count
        set({ peers: msg.peers, connected: true })
      } else {
        // Client: first joined confirmation → go to app
        set({ screen: 'app', role: 'client', connected: true })
      }
      break

    case 'peer_joined':
      set({ peers: S.peers + 1, screen: 'app', connected: true })
      break

    case 'peer_left':
      set({ peers: Math.max(0, S.peers - 1) })
      break

    case 'host_offline':
      set({ connected: false })
      break

    case 'disconnected':
      set({ connected: false })
      break

    case 'reconnecting':
      set({ connected: false })
      break

    case 'error':
      set({ screen: S.role === 'host' ? 'landing' : 'client-entry', error: msg.message })
      break
  }
}

// Data handler registry — modules call onData(role, type, fn) to register
const hostHandlers   = new Map()
const clientHandlers = new Map()

export function onData(role, type, fn) {
  ;(role === 'host' ? hostHandlers : clientHandlers).set(type, fn)
}

function onHostData(msg) {
  hostHandlers.get(msg.type)?.(msg)
}

function onClientData(msg) {
  clientHandlers.get(msg.type)?.(msg)
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  root.innerHTML = SCREENS[S.screen]?.() ?? ''
}

function afterRender() {
  if (S.screen === 'client-entry') {
    document.getElementById('code-input')?.focus()
  }
}

async function generateQR(code) {
  const url = `${JOIN_ORIGIN}?join=${code}`
  try {
    const dataUrl = await QRCode.toDataURL(url, {
      width: 200,
      margin: 2,
      color: { dark: '#E8E4DC', light: '#1A1814' },
    })
    set({ qrDataUrl: dataUrl })
  } catch (e) {
    console.warn('[qr] generation failed:', e)
  }
}

// ── Screens ───────────────────────────────────────────────────────────────────

const SCREENS = {

  landing: () => `
    <div class="screen">
      <div class="hero">
        <div class="hero-emoji">🐸</div>
        <h1 class="hero-title">Companions</h1>
        <p class="hero-sub">One vault. Two companions.</p>
      </div>
      <div class="action-stack">
        <button class="btn btn-primary" data-action="open-host">
          Open as Host
        </button>
        <button class="btn btn-secondary" data-action="open-client">
          Join a Session
        </button>
        ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
        ${!hasFileApi
          ? `<p class="warn">Host mode requires Chrome or Edge on desktop.</p>`
          : ''}
      </div>
    </div>`,

  loading: () => `
    <div class="screen">
      <div class="stack center">
        <div class="spinner"></div>
        <p class="muted">Setting up session…</p>
      </div>
    </div>`,

  'host-waiting': () => {
    const joinUrl = `${JOIN_ORIGIN}?join=${S.code}`
    return `
      <div class="screen">
        <button class="btn btn-ghost" style="align-self:flex-start;margin-bottom:16px" data-action="back">← Back</button>

        <div class="code-block">
          <p class="code-label">Session code</p>
          <p class="code-digits">${fmt(S.code)}</p>
        </div>

        <div class="qr-wrap">
          ${ S.qrDataUrl
            ? `<img src="${S.qrDataUrl}" width="200" height="200" style="display:block;border-radius:8px">`
            : `<div style="width:200px;height:200px;display:flex;align-items:center;justify-content:center">
                 <div class="spinner"></div>
               </div>`
          }
        </div>

        <p class="muted" style="margin-bottom:14px">Scan to open on another device</p>

        <div style="display:flex;align-items:center;gap:10px;width:100%;max-width:340px;margin-bottom:24px">
          <span style="flex:1;font-size:13px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(joinUrl)}</span>
          <button class="btn btn-secondary btn-sm" style="flex-shrink:0" data-action="copy-link">
            ${S.copied ? '✓ Copied' : 'Copy link'}
          </button>
        </div>

        <div class="waiting-row">
          ${S.peers > 0
            ? `<span class="status-dot on"></span><span>${S.peers} client${S.peers > 1 ? 's' : ''} connected</span>`
            : `<span class="spinner" style="width:14px;height:14px;border-width:2px"></span>
               <span>Waiting for a client to connect…</span>`}
        </div>
        <p class="small" style="margin-top:10px">Keep this tab open while using the app on another device</p>
      </div>`
  },

  'client-entry': () => `
    <div class="screen">
      <button class="btn btn-ghost back-btn" data-action="back">← Back</button>
      <div class="stack">
        <div class="center" style="margin-bottom:8px">
          <h2 class="page-title">Join a session</h2>
          <p class="page-sub">Enter the 6-character code shown on the host device</p>
        </div>
        <input
          id="code-input"
          class="input code-input"
          type="text"
          inputmode="text"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          maxlength="6"
          placeholder="ABC123"
          value="${esc(S.inputCode)}"
        />
        <button
          class="btn btn-primary"
          data-action="connect-client"
          ${S.inputCode.length !== 6 ? 'disabled' : ''}
        >Connect</button>
        ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
      </div>
    </div>`,

  'client-connecting': () => `
    <div class="screen">
      <div class="stack center">
        <div class="spinner"></div>
        <p class="muted">Connecting to <strong>${fmt(S.code)}</strong>…</p>
        <p class="small" style="margin-top:4px">relay: ${RELAY_WS}</p>
        <button class="btn btn-ghost" style="margin-top:16px" data-action="back">✕ Cancel</button>
      </div>
    </div>`,

  app: () => {
    const tabs = [
      { id: 'today', emoji: '📅', label: 'Today'  },
      { id: 'chat',  emoji: '💬', label: 'Chat'   },
      { id: 'ruse',  emoji: '🎨', label: 'Ruse'   },
      { id: 'vault', emoji: '📁', label: 'Vault'  },
    ]
    return `
      <div class="status-bar">
        <span class="status-dot ${S.connected ? 'on' : 'off'}"></span>
        <span class="status-role">${S.role?.toUpperCase()}</span>
        ${S.role === 'host' && S.peers > 0
          ? `<span class="status-peers">· ${S.peers} connected</span>` : ''}
        <span class="status-code">${fmt(S.code)}</span>
      </div>
      ${!S.connected
        ? `<div class="offline-banner">⚡ Host offline — showing cached data</div>`
        : ''}
      <div class="tab-content">
        ${TAB_CONTENT[S.tab]?.() ?? ''}
      </div>
      <div class="tab-bar">
        ${tabs.map(t => `
          <button class="tab-btn ${S.tab === t.id ? 'active' : ''}"
            data-action="switch-tab" data-tab="${t.id}">
            <span>${t.emoji}</span>
            <span class="label">${t.label}</span>
          </button>`).join('')}
      </div>`
  },
}

// ── Tab content stubs (replaced by Steps 4–9) ─────────────────────────────────

const TAB_CONTENT = {
  today: () => `
    <div class="placeholder">
      <div class="placeholder-icon">📅</div>
      <p class="placeholder-title">Today</p>
      <p class="placeholder-sub">Calendar · Todos · Weekly phrase · Haiku<br>Coming in Step 5</p>
    </div>`,

  chat: () => `
    <div class="placeholder">
      <div class="placeholder-icon">💬</div>
      <p class="placeholder-title">Chat</p>
      <p class="placeholder-sub">Saniel · Ruse<br>Coming in Step 6</p>
    </div>`,

  ruse: () => `
    <div class="placeholder">
      <div class="placeholder-icon">🎨</div>
      <p class="placeholder-title">Ruse Page</p>
      <p class="placeholder-sub">AI-editable HTML canvas<br>Coming in Step 7</p>
    </div>`,

  vault: () => `
    <div class="placeholder">
      <div class="placeholder-icon">📁</div>
      <p class="placeholder-title">Vault</p>
      <p class="placeholder-sub">Files · Wiki search<br>Coming in Step 4</p>
    </div>`,
}

// Expose for later steps to replace tab content
export function registerTab(id, fn) { TAB_CONTENT[id] = fn }
export { S, set }

// ── XSS guard ─────────────────────────────────────────────────────────────────

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function boot() {
  // Auto-fill code from URL param
  const join = new URLSearchParams(window.location.search).get('join')
  if (join) {
    S.screen    = 'client-entry'
    S.inputCode = join.toUpperCase().slice(0, 6)
  }
  render()
  afterRender()
}

boot()
