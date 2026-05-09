/**
 * app/crypto.test.js
 * Run: node app/crypto.test.js
 */

import { deriveKey, encrypt, decrypt } from './crypto.js'

let passed = 0
let failed = 0

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}`)
    failed++
  }
}

async function run() {
  console.log('crypto.js tests\n')

  // ── 1. Basic round-trip ───────────────────────────────────────────────────
  console.log('1. round-trip')
  const key = await deriveKey('ABC123')
  const msg = { type: 'vault_read', id: 'r1', path: 'journal/2026-05-09.md' }
  const payload = await encrypt(key, msg)
  const result  = await decrypt(key, payload)
  assert(typeof payload === 'string',    'encrypt returns a string')
  assert(result.type === msg.type,       'type survives round-trip')
  assert(result.path === msg.path,       'path survives round-trip')
  assert(result.id   === msg.id,         'id survives round-trip')

  // ── 2. Random IV — same input, different ciphertext every time ────────────
  console.log('\n2. random IV')
  const p1 = await encrypt(key, msg)
  const p2 = await encrypt(key, msg)
  assert(p1 !== p2, 'same plaintext → different ciphertexts')
  const r1 = await decrypt(key, p1)
  const r2 = await decrypt(key, p2)
  assert(JSON.stringify(r1) === JSON.stringify(r2), 'both still decrypt correctly')

  // ── 3. Wrong key throws ───────────────────────────────────────────────────
  console.log('\n3. wrong key rejection')
  const wrongKey = await deriveKey('WRONG1')
  let threw = false
  try { await decrypt(wrongKey, payload) } catch { threw = true }
  assert(threw, 'wrong key throws on decrypt')

  // ── 4. Tamper detection ───────────────────────────────────────────────────
  console.log('\n4. tamper detection')
  const chars  = payload.split('')
  chars[25]    = chars[25] === 'A' ? 'B' : 'A'  // flip one char deep in ciphertext
  const tampered = chars.join('')
  let tamperThrew = false
  try { await decrypt(key, tampered) } catch { tamperThrew = true }
  assert(tamperThrew, 'tampered payload throws on decrypt')

  // ── 5. Case-insensitive code ──────────────────────────────────────────────
  console.log('\n5. case-insensitive code')
  const lowerKey  = await deriveKey('abc123')
  const mixedKey  = await deriveKey('Abc123')
  const fromLower = await decrypt(lowerKey, payload)
  const fromMixed = await decrypt(mixedKey, payload)
  assert(fromLower.path === msg.path, 'lowercase code decrypts correctly')
  assert(fromMixed.path === msg.path, 'mixed-case code decrypts correctly')

  // ── 6. All message types round-trip ──────────────────────────────────────
  console.log('\n6. all protocol message types')
  const messages = [
    { id: 'r1', type: 'vault_list',            path: 'projects' },
    { id: 'r2', type: 'vault_read',            path: 'wiki/_index.md' },
    { id: 'r3', type: 'vault_write',           path: 'tasks/inbox.md', content: '- [ ] do thing' },
    { id: 'r4', type: 'llm_request',           persona: 'saniel', messages: [{ role: 'user', content: 'hi' }] },
    { id: 'r4', type: 'llm_chunk',             text: 'Hello, I am Saniel.' },
    { id: 'r4', type: 'llm_end' },
    { id: 'r5', type: 'calendar_fetch',        start: '2026-05-09', days: 7 },
    { id: 'r6', type: 'creative_write',        html: '<html><body><h1>Hello</h1></body></html>' },
    { id: 'r7', type: 'brain_dump',            text: 'Remember to call mum' },
    { id: 'r8', type: 'wiki_search',           query: 'what do I know about stoicism' },
  ]
  for (const m of messages) {
    const enc = await encrypt(key, m)
    const dec = await decrypt(key, enc)
    assert(dec.type === m.type, `${m.type}`)
  }

  // ── 7. Large payload (100KB) ──────────────────────────────────────────────
  console.log('\n7. large payload')
  const large    = { type: 'vault_read_response', content: 'x'.repeat(100_000) }
  const largeEnc = await encrypt(key, large)
  const largeDec = await decrypt(key, largeEnc)
  assert(largeDec.content.length === 100_000, '100KB payload survives round-trip')

  // ── 8. Creative page HTML ─────────────────────────────────────────────────
  console.log('\n8. creative page HTML payload')
  const html = `<!DOCTYPE html><html><head><title>Ruse</title></head><body>
    <h1>My Creative Space</h1><p>${'paragraph '.repeat(500)}</p>
  </body></html>`
  const htmlEnc = await encrypt(key, { type: 'creative_write', html })
  const htmlDec = await decrypt(key, htmlEnc)
  assert(htmlDec.html === html, 'HTML payload survives round-trip intact')

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
  console.log('\nAll tests passed ✓')
}

run().catch(e => { console.error('\nUnexpected error:', e); process.exit(1) })
