# webcom relay

Dumb WebSocket relay. Forwards encrypted blobs between a host browser and client browsers. Never reads or stores message content.

---

## Local dev

```bash
cd relay
npm install
npm run dev
# listening on :3001
```

Test it:
```bash
# health check
curl http://localhost:3001/health

# create a session
curl -X POST http://localhost:3001/session/create
# → { "code": "ABC123" }
```

---

## Deploy to Railway

1. Push this folder to a GitHub repo
2. New project → Deploy from GitHub repo → select the repo
3. Railway auto-detects Node, runs `npm start`
4. Note the generated URL, e.g. `https://webcom-relay.up.railway.app`

Set environment variable if needed:
```
PORT=3001   (Railway sets this automatically)
```

---

## API

### HTTP

| Method | Path | Description |
|---|---|---|
| GET | /health | `{ ok, sessions }` |
| POST | /session/create | `{ code }` — creates a new session |

### WebSocket

Connect to `ws://localhost:3001` (or `wss://` in production).

**First message must be a join:**
```json
{ "type": "join", "code": "ABC123", "role": "host" }
{ "type": "join", "code": "ABC123", "role": "client" }
```

**Server replies:**
```json
{ "type": "joined", "role": "host", "peers": 0 }
{ "type": "joined", "role": "client", "peers": 1 }
```

**Send a message (forwarded to peer):**
```json
{ "type": "message", "payload": "<base64-encrypted-blob>" }
```

**Server-to-client control:**
```json
{ "type": "peer_joined" }
{ "type": "peer_left" }
{ "type": "host_offline" }
{ "type": "error", "message": "..." }
```

---

## Notes

- Sessions expire after 2 hours of inactivity
- One host per session, multiple clients allowed
- Host can reconnect after tab close if session hasn't expired
- Max 200 concurrent sessions
- Max 512KB per message
- All payloads are E2E encrypted — relay only sees base64 ciphertext
