/**
 * app/crypto.js
 *
 * E2E encryption for the relay channel.
 * Uses the Web Crypto API — works unchanged in browser and Node 18+.
 *
 * Session code → PBKDF2 (100k iterations, SHA-256) → 256-bit AES-GCM key
 * Both devices derive the same key independently — no key exchange needed.
 * Each message gets a fresh random 12-byte IV, prepended to the ciphertext.
 * AES-GCM provides both confidentiality and authentication — tampered
 * messages will throw on decrypt.
 *
 * Usage:
 *   const key     = await deriveKey('ABC123')       // once per session
 *   const payload = await encrypt(key, { type: 'vault_read', path: 'foo.md' })
 *   const msg     = await decrypt(key, payload)     // back to original object
 */

const SALT       = new TextEncoder().encode('companions-lite-v1')
const ITERATIONS = 100_000

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derive a 256-bit AES-GCM key from a session code.
 * Call once per session and reuse the returned CryptoKey.
 * Codes are normalised to uppercase so ABC123 === abc123.
 */
export async function deriveKey(sessionCode) {
  const raw = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(sessionCode.toUpperCase().trim()),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

// ── Encrypt / decrypt ─────────────────────────────────────────────────────────

/**
 * Encrypt any JSON-serialisable value.
 * Returns a base64 string: [12-byte IV][ciphertext].
 */
export async function encrypt(key, value) {
  const iv       = crypto.getRandomValues(new Uint8Array(12))
  const encoded  = new TextEncoder().encode(JSON.stringify(value))
  const cipher   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  const combined = new Uint8Array(12 + cipher.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(cipher), 12)
  return bytesToBase64(combined)
}

/**
 * Decrypt a base64 string produced by encrypt().
 * Returns the original value.
 * Throws if the key is wrong or the payload has been tampered with.
 */
export async function decrypt(key, base64) {
  const combined = base64ToBytes(base64)
  const iv       = combined.slice(0, 12)
  const cipher   = combined.slice(12)
  const plain    = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
  return JSON.parse(new TextDecoder().decode(plain))
}

// ── Base64 helpers (browser + Node 16+) ──────────────────────────────────────

function bytesToBase64(bytes) {
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
}

function base64ToBytes(str) {
  return new Uint8Array(Array.from(atob(str), c => c.charCodeAt(0)))
}
