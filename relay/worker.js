/**
 * relay/worker.js
 *
 * Cloudflare Worker + Durable Object relay for Companions Lite.
 * Forwards encrypted blobs between a host browser and one or more client browsers.
 * Never reads, stores, or acts on message content — all payloads are E2E encrypted.
 *
 * HTTP:
 *   GET  /health           → { ok }
 *   POST /session/create   → { code }
 *
 * WebSocket:
 *   WS /?code=ABC123&role=host|client
 *   Server sends immediately: { type: "joined", role, peers }
 *   Data messages:            { type: "message", payload: "<base64>" }
 *   Control (server→client):  "peer_joined" | "peer_left" | "host_joined" | "host_offline" | "error"
 */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function makeCode() {
  return Array.from(
    { length: 6 },
    () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  ).join('')
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: corsHeaders() })
}

function wsReject(message) {
  const { 0: client, 1: server } = new WebSocketPair()
  server.accept()
  server.send(JSON.stringify({ type: 'error', message }))
  server.close(1008, message)
  return new Response(null, { status: 101, webSocket: client })
}

// ── Main Worker ────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true })
    }

    // Generate a code — the DO is created lazily on first WebSocket connection
    if (request.method === 'POST' && url.pathname === '/session/create') {
      return json({ code: makeCode() })
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const code = url.searchParams.get('code')?.toUpperCase().trim()
      const role = url.searchParams.get('role')
      if (!code || !role) return new Response('Missing code or role', { status: 400 })
      const stub = env.RELAY.get(env.RELAY.idFromName(code))
      return stub.fetch(request)
    }

    return new Response('Not found', { status: 404 })
  },
}

// ── Durable Object ─────────────────────────────────────────────────────────────
// Uses the classic server.accept() pattern with addEventListener — no hibernation.
// The DO instance stays alive as long as WebSockets are open, holding session
// state in plain instance variables (same model as the original Node.js relay).

export class RelaySession {
  constructor(state) {
    this.ctx = state
    this.host    = null          // WebSocket | null
    this.clients = new Set()     // Set<WebSocket>
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const url  = new URL(request.url)
    const role = url.searchParams.get('role')

    if (role !== 'host' && role !== 'client') return wsReject('role must be host or client')
    if (role === 'host' && this.host !== null) return wsReject('session already has a host')

    const { 0: client, 1: server } = new WebSocketPair()
    server.accept()

    if (role === 'host') {
      this.host = server
      server.send(JSON.stringify({ type: 'joined', role: 'host', peers: this.clients.size }))
      // Notify waiting clients that the host is now online
      if (this.clients.size > 0) {
        const note = JSON.stringify({ type: 'host_joined' })
        for (const c of this.clients) this.#trySend(c, note)
      }
    } else {
      this.clients.add(server)
      server.send(JSON.stringify({ type: 'joined', role: 'client', peers: this.host ? 1 : 0 }))
      if (this.host) this.#trySend(this.host, JSON.stringify({ type: 'peer_joined' }))
    }

    server.addEventListener('message', ({ data }) => {
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (msg.type !== 'message' || !msg.payload) return

      const out = JSON.stringify({ type: 'message', payload: msg.payload })

      if (role === 'host') {
        for (const c of this.clients) this.#trySend(c, out)
      } else {
        if (this.host) {
          this.#trySend(this.host, out)
        } else {
          this.#trySend(server, JSON.stringify({ type: 'host_offline' }))
        }
      }
    })

    server.addEventListener('close', () => {
      if (role === 'host') {
        this.host = null
        const note = JSON.stringify({ type: 'host_offline' })
        for (const c of this.clients) this.#trySend(c, note)
      } else {
        this.clients.delete(server)
        if (this.host) this.#trySend(this.host, JSON.stringify({ type: 'peer_left' }))
      }
    })

    server.addEventListener('error', () => { try { server.close() } catch {} })

    return new Response(null, { status: 101, webSocket: client })
  }

  #trySend(ws, msg) {
    try { ws.send(msg) } catch {}
  }
}
