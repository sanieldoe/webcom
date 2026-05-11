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
 *   Control (server→client):  "peer_joined" | "peer_left" | "host_offline" | "error"
 *
 * Requires Cloudflare Workers Paid plan (Durable Objects).
 */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const TTL_MS     = 2 * 60 * 60 * 1000   // 2-hour inactivity TTL

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

// Close a WebSocket with an error message before the client can do anything.
// Uses the old server.accept() API intentionally — these are fire-and-forget
// connections that we never want to hibernate.
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

    if (request.method === 'POST' && url.pathname === '/session/create') {
      const code = makeCode()
      const stub = env.RELAY.get(env.RELAY.idFromName(code))
      const res  = await stub.fetch(new Request('http://internal/init', { method: 'POST' }))
      if (!res.ok) return json({ error: 'could not create session' }, 500)
      return json({ code })
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

export class RelaySession {
  constructor(state) {
    this.ctx = state
  }

  async fetch(request) {
    const url = new URL(request.url)

    // ── Session init (called by main worker on POST /session/create) ──────────
    if (url.pathname === '/init') {
      const existing = await this.ctx.storage.get('created')
      if (!existing) await this.ctx.storage.put('created', Date.now())
      await this.ctx.storage.setAlarm(Date.now() + TTL_MS)
      return new Response('ok')
    }

    // ── WebSocket upgrade ─────────────────────────────────────────────────────
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const created = await this.ctx.storage.get('created')
    if (!created) return wsReject('session not found')

    const role = url.searchParams.get('role')
    if (role !== 'host' && role !== 'client') return wsReject('role must be host or client')

    if (role === 'host' && this.ctx.getWebSockets('host').length > 0) {
      return wsReject('session already has a host')
    }

    // Accept with role as tag — this enables WebSocket hibernation so we don't
    // burn CPU while connections are idle between messages.
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, [role])

    // Reset TTL on each new connection
    this.ctx.storage.setAlarm(Date.now() + TTL_MS)

    // Send joined confirmation. The newly accepted socket is already in
    // getWebSockets(), so subtract 1 for the peer count when role matches.
    const hosts   = this.ctx.getWebSockets('host')
    const clients = this.ctx.getWebSockets('client')

    if (role === 'host') {
      server.send(JSON.stringify({ type: 'joined', role: 'host', peers: clients.length }))
    } else {
      server.send(JSON.stringify({ type: 'joined', role: 'client', peers: hosts.length }))
      if (hosts.length > 0) {
        hosts[0].send(JSON.stringify({ type: 'peer_joined' }))
      }
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  // ── Hibernatable WebSocket handlers ───────────────────────────────────────

  webSocketMessage(ws, message) {
    let msg
    try { msg = JSON.parse(message) } catch { return }
    if (msg.type !== 'message' || !msg.payload) return

    // Reset TTL on activity (fire-and-forget — no await needed here)
    this.ctx.storage.setAlarm(Date.now() + TTL_MS)

    const role = ws.getTags()[0]   // 'host' or 'client'

    if (role === 'host') {
      const payload = JSON.stringify({ type: 'message', payload: msg.payload })
      for (const c of this.ctx.getWebSockets('client')) c.send(payload)
    } else {
      const hosts = this.ctx.getWebSockets('host')
      if (hosts.length > 0) {
        hosts[0].send(JSON.stringify({ type: 'message', payload: msg.payload }))
      } else {
        ws.send(JSON.stringify({ type: 'host_offline' }))
      }
    }
  }

  webSocketClose(ws) {
    const role = ws.getTags()[0]

    if (role === 'host') {
      const msg = JSON.stringify({ type: 'host_offline' })
      for (const c of this.ctx.getWebSockets('client')) c.send(msg)
    } else if (role === 'client') {
      const hosts = this.ctx.getWebSockets('host')
      if (hosts.length > 0) {
        hosts[0].send(JSON.stringify({ type: 'peer_left' }))
      }
    }
  }

  webSocketError(ws) {
    // Errors always trigger close, so webSocketClose handles cleanup.
    ws.close()
  }

  // ── Alarm — TTL expired ───────────────────────────────────────────────────

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1001, 'session expired') } catch {}
    }
    await this.ctx.storage.deleteAll()
  }
}
