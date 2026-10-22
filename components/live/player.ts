'use client'

import { gatewayScriptUrl } from '@/lib/streams/wall'

// go2rtc's <video-stream> element is defined by a script the gateway serves. It is loaded once, as a module, the first time a tile needs it.
// The element is created from code (not written in JSX): React would set `src` as an attribute on an element that is not defined yet,
// and the player only reacts to the `src` property.

let loading: Promise<void> | null = null
let attempts = 0

export function loadPlayer(gateway: string): Promise<void> {
  if (typeof customElements === 'undefined') return Promise.reject(new Error('no browser'))
  if (customElements.get('video-stream')) return Promise.resolve()
  if (!loading) {
    const script = document.createElement('script')
    script.type = 'module'
    script.src = gatewayScriptUrl(gateway, attempts++)
    loading = new Promise<void>((resolve, reject) => {
      script.onload = () => resolve()
      script.onerror = () => {
        script.remove()
        loading = null // the next try loads it again
        reject(new Error('player script not loaded'))
      }
    }).then(() => customElements.whenDefined('video-stream')).then(() => undefined)
    loading.catch(() => {})
    document.head.append(script)
  }
  return loading
}

export type PlayerEvents = {
  /** The picture is moving. */
  onPlaying: () => void
  /** The socket closed or go2rtc reported an error. */
  onEnded: () => void
  /** The picture element, as soon as it exists (its currentTime says how far the picture has played). */
  onVideo?: (video: HTMLVideoElement) => void
}

/**
 * Starts one picture inside `host`. No sound is ever asked for (media is video only and the element is muted), the player's own
 * overlay and controls are not used, and the player does not watch the tab itself (the wall pauses tiles). Returns a function that
 * stops everything at once: the socket is closed now, not after the player's own five second delay.
 */
export function startPlayer(host: HTMLElement, socketUrl: string, events: PlayerEvents): () => void {
  const el = document.createElement('video-stream')
  let stopped = false
  el.mode = 'mse'
  el.media = 'video'
  el.background = false
  el.visibilityCheck = false
  el.style.display = 'block'
  el.style.width = '100%'
  el.style.height = '100%'

  const proto = Object.getPrototypeOf(el) as { onopen: (this: VideoStreamElement) => string[] }
  const ended = () => {
    if (!stopped) events.onEnded()
  }
  // The player would reconnect by itself with the same (maybe expired) token; the tile decides when to try again instead.
  Object.defineProperty(el, 'onclose', {
    configurable: true,
    writable: true,
    value: () => {
      el.ws = null
      el.wsState = WebSocket.CLOSED
      ended()
      return false
    },
  })
  Object.defineProperty(el, 'onopen', {
    configurable: true,
    writable: true,
    value: () => {
      const modes = proto.onopen.call(el)
      el.onmessage['tile'] = (msg) => {
        if (msg.type === 'error') ended()
      }
      return modes
    },
  })

  host.append(el) // creates the <video> inside
  // The player's own mode/status overlay is not used. Its stylesheet is not in a CSS layer, so only an inline style can hide it.
  el.querySelector<HTMLElement>('.info')?.style.setProperty('display', 'none')
  if (el.video) {
    el.video.muted = true
    el.video.controls = false
    el.video.autoplay = true
    el.video.disablePictureInPicture = true
    el.video.style.objectFit = 'contain'
    el.video.addEventListener('playing', () => {
      if (!stopped) events.onPlaying()
    })
  }
  if (el.video) events.onVideo?.(el.video)
  el.src = socketUrl

  return () => {
    if (stopped) return
    stopped = true
    try {
      if (el.reconnectTID) clearTimeout(el.reconnectTID)
      if (el.disconnectTID) clearTimeout(el.disconnectTID)
      el.reconnectTID = 0
      el.disconnectTID = 0
      el.wsURL = '' // nothing can reconnect it now
      if (el.video) el.ondisconnect() // closes the socket and lets go of the picture buffers
    } catch {
      // already closed
    }
    el.remove()
  }
}
