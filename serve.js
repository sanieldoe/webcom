/**
 * serve.js — combined dev server
 *
 * Serves static files from app/ AND runs the WebSocket relay on the same port.
 * One port, one URL — phones and tablets can connect without firewall issues.
 *
 * In production:
 *   - Static files  → Cloudflare Pages
 *   - Relay         → relay/worker.js on Cloudflare Workers (cd relay && npm run deploy)
 */

import http         from 'node:http'
import fs           from 'node:fs'
import path         from 'node:path'
import os           from 'node:os'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'

const PORT    = Number(process.env.PORT ?? 4000)
const ROOT    = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app')
const TTL_MS  = 2 * 60 * 60 * 1000   // 2-hour session TTL
const MAX_SESSIONS  = 200
const MAX_PAYLOAD   = 512 * 1024
const HEARTBEAT_MS  = 30_000
const CODE_CHARS    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'text/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json',
  '.png':   'image/png',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff2': 'font/woff2',
  '.webp':  'image/webp',
}

// ── Relay state ───────────────────────────────────────────────────────────────

const sessions = new Map()  // code → { host, clients, expiresAt }

function makeCode() {
  let code
  do {
    code = Array.from({ length: 6 },
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
  for (const ws of targets) if (ws.readyState === WebSocket.OPEN) ws.send(msg)
}

function touch(s) { s.expiresAt = Date.now() + TTL_MS }

// Clean up expired sessions every 15 min
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

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const urlPath = req.url?.split('?')[0] ?? '/'

  // ── Relay API ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }))
    return
  }

  if (req.method === 'POST' && urlPath === '/session/create') {
    if (sessions.size >= MAX_SESSIONS) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'server full' }))
      return
    }
    const code = makeCode()
    sessions.set(code, { host: null, clients: new Set(), expiresAt: Date.now() + TTL_MS })
    console.log(`[relay] created: ${code}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code }))
    return
  }

  // ── Static files ────────────────────────────────────────────────────────
  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath)

  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(ROOT, 'index.html')   // SPA fallback
  }

  try {
    const content = fs.readFileSync(filePath)
    const ext = path.extname(filePath)
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
    res.end(content)
  } catch {
    res.writeHead(404); res.end('Not found')
  }
})

// ── WebSocket relay ───────────────────────────────────────────────────────────

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

wss.on('connection', (ws, req) => {
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  // Code and role come from URL params (matches the Cloudflare Worker protocol)
  const params  = new URL(req.url, 'http://localhost').searchParams
  const code    = params.get('code')?.toUpperCase().trim()
  const role    = params.get('role')

  const session = sessions.get(code)
  if (!session) {
    send(ws, { type: 'error', message: 'session not found' })
    ws.close(); return
  }
  if (role !== 'host' && role !== 'client') {
    send(ws, { type: 'error', message: 'role must be host or client' })
    ws.close(); return
  }
  if (role === 'host' && session.host?.readyState === WebSocket.OPEN) {
    send(ws, { type: 'error', message: 'session already has a host' })
    ws.close(); return
  }

  touch(session)

  if (role === 'host') {
    session.host = ws
    send(ws, { type: 'joined', role: 'host', peers: session.clients.size })
    console.log(`[relay] host joined: ${code}`)
  } else {
    session.clients.add(ws)
    send(ws, { type: 'joined', role: 'client', peers: session.host ? 1 : 0 })
    if (session.host) send(session.host, { type: 'peer_joined' })
    console.log(`[relay] client joined: ${code} (${session.clients.size} total)`)
  }

  ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data) } catch { return }

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
    if (role === 'host') {
      session.host = null
      broadcast(session.clients, { type: 'host_offline' })
      console.log(`[relay] host left`)
    } else {
      session.clients.delete(ws)
      if (session.host) send(session.host, { type: 'peer_left' })
      console.log(`[relay] client left (${session.clients.size} remaining)`)
    }
  })

  ws.on('error', () => ws.close())
})

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = Object.values(os.networkInterfaces())
    .flat()
    .find(i => i.family === 'IPv4' && !i.internal)
    ?.address ?? '?.?.?.?'

  console.log('')
  console.log('  Companions Lite')
  console.log('')
  console.log(`  Local   →  http://localhost:${PORT}`)
  console.log(`  Network →  http://${lanIp}:${PORT}`)
  console.log('')
  console.log('  Mac:   open http://localhost:' + PORT)
  console.log('  Phone: open http://' + lanIp + ':' + PORT)
  console.log('')
})
