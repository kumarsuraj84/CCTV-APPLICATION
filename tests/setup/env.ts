// Vitest does not load .env.local the way Next does, so do it before any test file runs.
import path from 'node:path'
import WebSocket from 'ws'

try {
  process.loadEnvFile(path.resolve(__dirname, '../../.env.local'))
} catch {
  // Nothing to load: fall back to whatever is already in process.env.
}

// Node 20 has no global WebSocket; supabase-js needs one just to construct a client.
if (!globalThis.WebSocket) {
  // @ts-expect-error -- ws's Node WebSocket is not the DOM WebSocket type
  globalThis.WebSocket = WebSocket
}
