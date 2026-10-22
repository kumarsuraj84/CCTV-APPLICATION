import type { DetailedHTMLProps, HTMLAttributes } from 'react'

// go2rtc's <video-stream> player (loaded from the gateway: /g/video-stream.js). The live tiles create it from code once the script
// has defined it (see components/live/player.ts); the JSX form is declared so it can also be written in markup.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'video-stream': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { mode?: string; src?: string; background?: boolean }
    }
  }
}

declare global {
  /** What a tile uses of the player (a subset of go2rtc's VideoRTC class). */
  interface VideoStreamElement extends HTMLElement {
    mode: string
    media: string
    background: boolean
    visibilityCheck: boolean
    src: string
    wsURL: string
    ws: WebSocket | null
    wsState: number
    video: HTMLVideoElement | null
    reconnectTID: number
    disconnectTID: number
    onmessage: Record<string, (msg: { type: string; value?: string }) => void>
    ondisconnect(): void
  }
  interface HTMLElementTagNameMap {
    'video-stream': VideoStreamElement
  }
}

export {}
