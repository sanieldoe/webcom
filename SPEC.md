# Companions Lite — v1 Spec

**One page. No fluff.**

---

## What it is

A personal webapp hosted on a domain. One device opens it and becomes the host — it has the vault, the models, the calendar. Any other device opens the same URL and becomes a client — full UI, connected to the host through a dumb relay on the server.

All messages between devices are **end-to-end encrypted**. The relay sees only ciphertext. Your data passes through the relay but cannot be read by it.

---

## Architecture

```
yourapp.com
├── static files (HTML / JS / CSS)
└── relay (~100 lines, Node/Bun) — forwards encrypted blobs only

Device A  (host)    Chrome desktop
├── vault           File System Access API
├── LLM             Ollama (primary) or OpenAI-compatible remote
├── Gemma 1B–2B     in-browser via WebLLM, wiki/search only
└── calendar        Google OAuth PKCE flow, tokens in IndexedDB

Device B  (client)  any browser, installs as PWA
└── full UI         all requests go to Device A via relay
```

Host and client derive a shared AES-GCM key from the session code using PBKDF2. The relay never holds the key and cannot read any message content. When the host tab is closed, the client falls back to its IndexedDB cache gracefully.

---

## E2E Encryption

Every data message is encrypted before leaving the browser.

```
Session code → PBKDF2 (100k iterations, SHA-256) → 256-bit AES-GCM key
Each message → encrypt(key, iv, plaintext) → { iv, ciphertext } → base64
Relay receives → opaque base64 blob → forwards to peer
Peer receives → base64 → decrypt(key, iv, ciphertext) → plaintext
```

Key derivation uses the session code as the password and a fixed app salt. Both devices independently derive the same key. No key exchange needed. ~50 lines using the browser Web Crypto API.

Control messages (join, register, ping) are unencrypted and contain no user data.

---

## Message protocol

All data messages are encrypted JSON. Each carries a unique `id` so responses can be matched to requests.

### Relay envelope (unencrypted)
```json
{ "type": "message", "payload": "<base64-encrypted-blob>" }
```

### Control messages (unencrypted, relay-only)
```json
{ "type": "join",          "code": "ABC123", "role": "host"|"client" }
{ "type": "joined",        "peers": 0 }
{ "type": "peer_joined" }
{ "type": "peer_left" }
{ "type": "host_offline" }
```

### Vault
```json
{ "id": "r1", "type": "vault_list",             "path": "projects" }
{ "id": "r1", "type": "vault_list_response",    "entries": [...] }
{ "id": "r1", "type": "vault_read",             "path": "journal/2026-05-09.md" }
{ "id": "r1", "type": "vault_read_response",    "content": "..." }
{ "id": "r1", "type": "vault_write",            "path": "tasks/inbox.md", "content": "..." }
{ "id": "r1", "type": "vault_write_response",   "ok": true }
```

### LLM streaming
```json
{ "id": "r1", "type": "llm_request",  "persona": "saniel"|"ruse", "messages": [...], "page_html": "..." }
{ "id": "r1", "type": "llm_chunk",    "text": "..." }
{ "id": "r1", "type": "llm_end" }
{ "id": "r1", "type": "llm_error",   "message": "..." }
{ "id": "r1", "type": "llm_abort" }
```

`page_html` is the current creative page, included when the request involves the creative space. Device A receives the request, calls Ollama, and streams each token back as `llm_chunk`. Device B appends chunks to the message as they arrive.

### Calendar
```json
{ "id": "r1", "type": "calendar_fetch",    "start": "2026-05-09", "days": 7 }
{ "id": "r1", "type": "calendar_response", "events": [...] }
```

Calendar OAuth lives on Device A only. Device A fetches events and sends them to Device B via relay. Access tokens expire in 1 hour — Device A refreshes automatically using the stored refresh token in IndexedDB. Device B never authenticates with Google directly.

### Creative space
```json
{ "id": "r1", "type": "creative_read",           }
{ "id": "r1", "type": "creative_read_response",  "html": "..." }
{ "id": "r1", "type": "creative_write",          "html": "..." }
{ "id": "r1", "type": "creative_write_response", "ok": true }
```

AI always returns a **full HTML replacement**. No partial diffing. The app replaces the iframe content entirely on each AI response. Simple and reliable.

### Brain dump
```json
{ "id": "r1", "type": "brain_dump",          "text": "..." }
{ "id": "r1", "type": "brain_dump_response", "ok": true, "path": "raw/..." }
```

Works from both devices. Device B sends the text via relay → Device A writes it to `raw/YYYY-MM-DD-HHmm-dump.md` in the vault.

### Wiki search
```json
{ "id": "r1", "type": "wiki_search",          "query": "..." }
{ "id": "r1", "type": "wiki_search_response", "chunks": [...] }
```

Device A runs the lexical search over the vault index and summarises with in-browser Gemma. Result sent to Device B.

---

## Session pairing

```
Device A → POST /session/create → relay returns code "ABC123"
Device A → WS /session/ABC123 + role=host → relay: "joined"
Device B → WS /session/ABC123 + role=client → relay: "joined", host gets "peer_joined"
All subsequent messages: Device A ↔ relay ↔ Device B (encrypted)
```

Session code is 6 alphanumeric characters. Relay holds session state in memory. Sessions expire after 2 hours of inactivity or when the host disconnects. If the host tab closes and reopens within the session TTL, it can reconnect with the same code.

---

## Host / client UX

Same URL. App detects no stored session and shows a landing screen:

```
[ Open as Host ]   [ Join a Session ]
```

**Host flow:**
1. Click "Open as Host"
2. Browser prompts: pick vault folder (File System Access API)
3. App contacts relay → gets session code
4. App displays: `Your code: ABC-123` + QR code linking to `yourapp.com?join=ABC123`
5. Device B scans QR or visits link → auto-fills code → connects

**Client flow:**
1. Enter 6-character code (or scan QR) → connect
2. Full UI appears — all four pillars available via relay

**Offline fallback (Device B when host is unreachable):**
- Last conversation messages → IndexedDB
- Last tracker state (todos, phrase, haiku, weekly phrase) → IndexedDB
- Last vault file listing → IndexedDB
- Last creative page HTML → IndexedDB
- Calendar events (last fetched) → IndexedDB
- App shows subtle "Host offline — showing cached data" banner

---

## The four pillars

### 1. Tracker
- **Calendar** — read-only, fetched by Device A, displayed on both. Google OAuth on Device A.
- **Todo list** — add tasks, set priority (high / medium / low), mark done, saved to `tasks/inbox.md`
- **Phrase for the week** — one editable line, saved to `tracker/week.md`
- **Daily haiku journal** — three lines, saved to `journal/YYYY-MM-DD.md`

### 2. Chat
**Saniel** — step-by-step mentor. Pushes back gently. Wants clarity of intent before moving. Slows you down on purpose.

**Ruse** — goal-driven finisher. May ask questions to understand the goal. Once defined, infers every decision and drives to the end result without checking in.

Same message thread. Toggle switches active persona. Persona tag prepended to each message so the model knows which mode to use. Conversations saved to vault under active project.

### 3. Creative Space
- Artifact: `vault/projects/inbox/creative-ruse.html`
- Split view: source editor (left) + live iframe preview (right)
- AI reads the full current HTML, rewrites the whole page, app replaces iframe content
- User can also edit source directly and save
- No schemas, no block types — raw HTML, limitless

### 4. Vault
- Browse `projects/`, `raw/`, `wiki/`, `journal/`
- Open, edit, save any text/markdown/html file
- Brain dump from any device
- Wiki search: on vault mount, Device A scans all markdown files → builds in-memory lexical index (filenames, headings, keywords, snippets) → Gemma summarises results → answer sent to requesting device

---

## Gemma first load

First time wiki search is used, the in-browser model must be downloaded.

- App shows: "Downloading local model — this happens once (~1GB)"
- WebLLM progress callback drives a progress bar
- Model cached in browser OPFS (Origin Private File System) after first load
- Subsequent loads: fast, no network needed
- Gemma runs on Device A only. Results reach Device B via relay.

---

## LLM strategy

| Task | Model | Runs on |
|---|---|---|
| Saniel / Ruse chat | Ollama (primary), OpenAI-compat remote (fallback) | Device A |
| Creative page rewrite | Same as chat | Device A |
| Tracker haiku / phrase | Same as chat | Device A |
| Wiki search + summarise | Gemma 1B–2B via WebLLM | Device A browser |

Ollama must have CORS enabled for localhost (`OLLAMA_ORIGINS=*` or the app's origin). One-time setup step documented in the app.

---

## Vault structure

```
vault/
  journal/
    2026-05-09.md        # haiku + reflection
  tasks/
    inbox.md             # priority todo list
  tracker/
    week.md              # phrase for the week
  raw/
    2026-05-09-1430-dump.md
  wiki/
    _index.md
    concepts/
    people/
  projects/
    inbox/
      creative-ruse.html
      README.md
```

---

## Technical stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vanilla JS or Preact | No build complexity |
| Styling | Single CSS file | Lean |
| In-browser model | WebLLM + Gemma 1B–2B | WebGPU, cached after first load |
| Encryption | Web Crypto API (AES-GCM + PBKDF2) | Native browser, no library |
| Relay | Node or Bun, ~100 lines | Simple WS server, no framework |
| Relay hosting | Railway (free tier) | Simple deploy, persistent process |
| Static hosting | Cloudflare Pages | Free, fast, global CDN |
| Vault access | File System Access API | Chrome/Edge desktop, no backend |
| Calendar | Google OAuth PKCE, tokens in IndexedDB | Browser-native, no server token store |
| Storage | IndexedDB + vault files | Offline-capable |
| PWA | manifest + service worker | Installs on phone/tablet |

HTTPS is required for File System Access API. Cloudflare Pages provides it automatically. Local dev uses `localhost` which is also a secure context.

---

## Device support

| Device | Mode | Notes |
|---|---|---|
| Chrome / Edge desktop | Host or client | Full features |
| Chrome mobile / Android | Client only | PWA install, no vault or model |
| Safari iOS | Client only | Limited — no File System API, no WebGPU |
| Firefox | Client only | No File System API |

**Primary target: Chrome desktop as host, Chrome mobile as client.**

---

## Hosting

```
Cloudflare Pages → yourapp.com (static HTML/JS/CSS)
Railway          → relay.yourapp.com (Node/Bun WS relay)
```

Two deploys. Both free tier. Relay connects to Cloudflare Pages origin via CORS. Static files served globally. Relay is one persistent process on Railway.

---

## Out of scope for v1

- Multiple creative pages / projects (one page, inbox project only)
- Wiki compile pipeline (Keeper-style ingest)
- Vector embeddings / LanceDB
- Calendar write-back by AI
- Multiple host devices
- Autonomous agent tool-calling
- Duplicate finder / linting
- Multi-vault support

---

## Build order

1. **Relay** — Node/Bun WS server, session create/join, in-memory sessions, Railway deploy
2. **Encryption module** — Web Crypto PBKDF2 key derivation + AES-GCM encrypt/decrypt, ~50 lines
3. **App shell** — host/client landing screen, session pairing, QR code display
4. **Vault bridge** — File System Access API on host, vault_list/read/write messages over relay
5. **Tracker** — calendar OAuth, todos, phrase, haiku, all reading/writing via vault bridge
6. **Chat** — Saniel + Ruse, Ollama streaming, llm_chunk relay, conversation persistence
7. **Creative Space** — HTML editor, iframe preview, full-page AI replace via chat
8. **Wiki search** — in-memory index on vault mount, Gemma integration, first-load UX
9. **Brain dump** — from both devices via relay
10. **Offline cache** — IndexedDB snapshots for all four pillars
11. **PWA** — manifest, service worker, install prompt
12. **Deploy** — Cloudflare Pages + Railway, domain config, HTTPS verify

---

*One vault. Two companions. One page.*
