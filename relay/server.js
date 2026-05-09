/**
 * relay/server.js
 *
 * Dumb WebSocket relay for Companions Lite.
 * Forwards encrypted blobs between a host browser and one or more client browsers.
 * Never reads, stores, or acts on message content — all payloads are E2E encrypted.
 *
 * HTTP:
 *   GET  /health           → { ok, sessions }
 *   POST /session/create   → { code }
 *
 * WebSocket:
 *   WS /
 *   First message must be: { type: "join", code: "ABC123", role: "host"|"client" }
 *   Server replies:        { type: "joined", role, peers }
 *   Data messages:         { type: "message", payload: "<base64>" }
 *   Control (server→client): "peer_joined" | "peer_left" | "host_offline" | "error"
 */

import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

const PORT          = Number(process.env.PORT ?? 3001)
const TTL_MS        = 2 * 60 * 60 * 1000   // 2 hours inactivity
const HEARTBEAT_MS  = 30_000                // ping interval
const MAX_SESSIONS  = 200
const MAX_PAYLOAD   = 512 * 1024            // 512KB per message
const CODE_CHARS    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no confusable chars

// sessions: Map<code, { host, clients, expiresAt }>
const sessions = new Map()

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCode() {
  let code
  do {
    code = Array.from(
      { length: 6 },
      () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join('')
  } while (sessions.has(code))
  return code
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

function broadcast(targets, obj) {
  const msg = JSON.stringify(obj)
  for (const ws of targets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg)
  }
}

function touch(session) {
  session.expiresAt = Date.now() + TTL_MS
}

// ── Session cleanup ───────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now()
  for (const [code, s] of sessions) {
    if (now > s.expiresAt) {
      if (s.host) s.host.terminate()
      for (const c of s.clients) c.terminate()
      sessions.delete(code)
      console.log(`[relay] expired: ${code}`)
    }
  }
}, 15 * 60 * 1000)

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }))
    return
  }

  if (req.method === 'POST' && req.url === '/session/create') {
    if (sessions.size >= MAX_SESSIONS) {
      res.writeHead(503)
      res.end(JSON.stringify({ error: 'server full' }))
      return
    }
    const code = makeCode()
    sessions.set(code, { host: null, clients: new Set(), expiresAt: Date.now() + TTL_MS })
    console.log(`[relay] created: ${code}`)
    res.writeHead(200)
    res.end(JSON.stringify({ code }))
    return
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }))
})

// ── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD })

// Heartbeat — detect and cull stale connections
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue }
    ws.isAlive = false
    ws.ping()
  }
}, HEARTBEAT_MS)

wss.on('close', () => clearInterval(heartbeat))

wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  let session = null
  let role    = null
  let joined  = false

  ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data) } catch { return }

    // ── Join handshake ──────────────────────────────────────────────────────
    if (!joined) {
      if (msg.type !== 'join' || !msg.code || !msg.role) {
        send(ws, { type: 'error', message: 'first message must be join' })
        ws.close(); return
      }

      session = sessions.get(msg.code)
      if (!session) {
        send(ws, { type: 'error', message: 'session not found' })
        ws.close(); return
      }

      role = msg.role

      if (role === 'host') {
        // Allow reconnect if old host socket is dead
        if (session.host?.readyState === WebSocket.OPEN) {
          send(ws, { type: 'error', message: 'session already has a host' })
          ws.close(); return
        }
        session.host = ws
        joined = true
        touch(session)
        send(ws, { type: 'joined', role: 'host', peers: session.clients.size })
        console.log(`[relay] host joined: ${msg.code}`)

      } else if (role === 'client') {
        session.clients.add(ws)
        joined = true
        touch(session)
        send(ws, { type: 'joined', role: 'client', peers: session.host ? 1 : 0 })
        if (session.host) send(session.host, { type: 'peer_joined' })
        console.log(`[relay] client joined: ${msg.code} (${session.clients.size} total)`)

      } else {
        send(ws, { type: 'error', message: 'role must be host or client' })
        ws.close()
      }
      return
    }

    // ── Forward encrypted payload ───────────────────────────────────────────
    if (msg.type === 'message' && msg.payload) {
      touch(session)
      if (role === 'host') {
        broadcast(session.clients, { type: 'message', payload: msg.payload })
      } else {
        if (session.host?.readyState === WebSocket.OPEN) {
          send(session.host, { type: 'message', payload: msg.payload })
        } else {
          send(ws, { type: 'host_offline' })
        }
      }
    }
  })

  ws.on('close', () => {
    if (!session) return
    if (role === 'host') {
      session.host = null
      broadcast(session.clients, { type: 'host_offline' })
      console.log(`[relay] host left`)
    } else if (role === 'client') {
      session.clients.delete(ws)
      if (session.host) send(session.host, { type: 'peer_left' })
      console.log(`[relay] client left (${session.clients.size} remaining)`)
    }
  })

  ws.on('error', () => ws.close())
})

server.listen(PORT, '0.0.0.0', () => console.log(`[relay] listening on 0.0.0.0:${PORT}`))
