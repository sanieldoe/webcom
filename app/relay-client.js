/**
 * app/relay-client.js
 *
 * WebSocket relay client with built-in E2E encryption.
 * Extends EventTarget — listen with:
 *   relay.on('control', msg)  → { type, ...} unencrypted relay signals
 *   relay.on('data',    msg)  → decrypted application message
 *
 * Control types: joined | peer_joined | peer_left | host_offline |
 *                disconnected | reconnecting | error
 */

import { deriveKey, encrypt, decrypt } from './crypto.js'

export class RelayClient extends EventTarget {
  #key            = null
  #ws             = null
  #code
  #role
  #relayUrl
  #alive          = true
  #reconnectDelay = 2_000

  constructor(relayUrl, sessionCode, role) {
    super()
    this.#relayUrl = relayUrl
    this.#code     = sessionCode.toUpperCase().trim()
    this.#role     = role
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async connect() {
    this.#key   = await deriveKey(this.#code)
    this.#alive = true
    this.#open()
  }

  /**
   * Encrypt and send an application message.
   * Returns true if sent, false if not connected.
   */
  async send(msg) {
    if (!this.#key || this.#ws?.readyState !== WebSocket.OPEN) return false
    const payload = await encrypt(this.#key, msg)
    this.#ws.send(JSON.stringify({ type: 'message', payload }))
    return true
  }

  disconnect() {
    this.#alive = false
    this.#ws?.close()
  }

  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN
  }

  // ── Private ───────────────────────────────────────────────────────────────

  #open() {
    if (!this.#alive) return

    let ws
    try {
      ws = new WebSocket(this.#relayUrl)
    } catch {
      this.#scheduleReconnect()
      return
    }

    this.#ws = ws

    ws.onopen = () => {
      this.#reconnectDelay = 2_000                            // reset backoff on success
      ws.send(JSON.stringify({ type: 'join', code: this.#code, role: this.#role }))
    }

    ws.onmessage = async ({ data }) => {
      let msg
      try { msg = JSON.parse(data) } catch { return }

      // ── Unencrypted control signals ───────────────────────────────────
      if (msg.type !== 'message') {
        this.#emit('control', msg)
        return
      }

      // ── Encrypted data payload ────────────────────────────────────────
      if (msg.payload) {
        try {
          const plain = await decrypt(this.#key, msg.payload)
          this.#emit('data', plain)
        } catch {
          console.warn('[relay] decrypt failed — wrong key or tampered message')
        }
      }
    }

    ws.onclose = () => {
      this.#emit('control', { type: 'disconnected' })
      this.#scheduleReconnect()
    }

    ws.onerror = () => ws.close()
  }

  #scheduleReconnect() {
    if (!this.#alive) return
    this.#emit('control', { type: 'reconnecting', delay: this.#reconnectDelay })
    setTimeout(() => this.#open(), this.#reconnectDelay)
    this.#reconnectDelay = Math.min(this.#reconnectDelay * 1.6, 30_000)
  }

  #emit(eventName, detail) {
    this.dispatchEvent(new CustomEvent(eventName, { detail }))
  }

  // Sugar so callers can write relay.on('data', fn) instead of addEventListener
  on(event, fn) { this.addEventListener(event, ({ detail }) => fn(detail)) }
}
