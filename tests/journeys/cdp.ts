// P5.5 browser journeys: a very small Chrome DevTools Protocol client for the headless Microsoft Edge that is already on this PC (no
// Playwright or Puppeteer: not a dependency of the project, and nothing is installed for this). Each browser context has its own cookies,
// so an administrator and a viewer can be signed in at the same time. Pages are driven the way a person would: fields found by their
// label, buttons by their words.
import WebSocket from 'ws'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class Cdp {
  private id = 0
  private pending = new Map<number, Pending>()
  private listeners = new Set<(m: { method: string; params: Record<string, unknown>; sessionId?: string }) => void>()
  private constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string }
      if (m.id !== undefined) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) p?.reject(new Error(m.error.message))
        else p?.resolve(m.result)
      } else if (m.method) for (const l of this.listeners) l({ method: m.method, params: m.params ?? {}, sessionId: m.sessionId })
    })
  }
  static async connect(debugPort: number): Promise<Cdp> {
    const v = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as { webSocketDebuggerUrl: string }
    const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return new Cdp(ws)
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.id
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  on(l: (m: { method: string; params: Record<string, unknown>; sessionId?: string }) => void) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  close() {
    this.ws.close()
  }
  /** A new, empty browser context (own cookies) with one page. */
  async newPage(): Promise<Page> {
    const { browserContextId } = await this.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true })
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(this, sessionId)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Network.enable')
    return page
  }
}

export class Page {
  readonly console: string[] = []
  private width = 1366
  private height = 768
  constructor(private cdp: Cdp, private sessionId: string) {
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return
      if (m.method === 'Runtime.consoleAPICalled') {
        const args = (m.params.args as { value?: unknown; description?: string }[]) ?? []
        this.console.push(`${m.params.type}: ${args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300)}`)
      }
      if (m.method === 'Runtime.exceptionThrown') this.console.push(`exception: ${String((m.params.exceptionDetails as { text?: string })?.text ?? '')}`.slice(0, 300))
    })
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) {
    return this.cdp.send<T>(method, params, this.sessionId)
  }
  async viewport(width: number, height: number) {
    this.width = width
    this.height = height
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768, screenWidth: width, screenHeight: height })
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: width < 768 })
  }
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value as T
  }
  async goto(url: string) {
    await this.send('Page.navigate', { url })
    await this.settle()
  }
  /** Waits for the document to be complete and the network to be quiet for a moment. */
  async settle(quietMs = 600, maxMs = 30_000) {
    const end = Date.now() + maxMs
    while (Date.now() < end) {
      const ready = await this.eval<string>('document.readyState').catch(() => 'loading')
      if (ready === 'complete') break
      await sleep(100)
    }
    await sleep(quietMs)
  }
  async url(): Promise<string> {
    return this.eval<string>('location.href')
  }
  async text(): Promise<string> {
    return this.eval<string>('document.body ? document.body.innerText : ""')
  }
  async waitFor(predicate: string, what: string, maxMs = 30_000) {
    const end = Date.now() + maxMs
    while (Date.now() < end) {
      if (await this.eval<boolean>(`(() => { try { return !!(${predicate}) } catch { return false } })()`).catch(() => false)) return
      await sleep(200)
    }
    throw new Error(`Timed out waiting for ${what}`)
  }
  async waitForText(t: string, maxMs = 30_000) {
    await this.waitFor(`document.body && document.body.innerText.includes(${JSON.stringify(t)})`, `the text "${t}"`, maxMs)
  }
  /** The control a label names (label[for], a wrapping label, aria-label), as a page-side expression. */
  private control(label: string, nth = 0): string {
    return `(${this.controls(label)}[${nth}] || null)`
  }
  private controls(label: string): string {
    return `(() => {
      const want = ${JSON.stringify(label)}.toLowerCase()
      const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      // Exact label words first (a label "Region" must not find "Region code"); only when none, labels that start with them.
      const exact = [], starts = []
      for (const l of document.querySelectorAll('label')) {
        const t = norm(l.innerText).replace(/\\s*\\*$/, '')
        const c = l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector('input,select,textarea')
        if (!c) continue
        if (t === want) exact.push(c)
        else if (t.startsWith(want)) starts.push(c)
      }
      for (const c of document.querySelectorAll('[aria-label]')) if (norm(c.getAttribute('aria-label')) === want) exact.push(c)
      return exact.length ? exact : starts
    })()`
  }
  /** How many controls the label names (the last one is usually the "add" form under a list of edit forms). */
  async count(label: string): Promise<number> {
    return this.eval<number>(`${this.controls(label)}.length`)
  }
  async fill(label: string, value: string, nth = 0) {
    const ok = await this.eval<boolean>(`(() => {
      const c = ${this.control(label, nth)}
      if (!c) return false
      c.focus()
      const proto = c.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(c, ${JSON.stringify(value)})
      c.dispatchEvent(new Event('input', { bubbles: true }))
      c.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    if (!ok) throw new Error(`No field labelled "${label}"`)
  }
  async select(label: string, optionText: string, nth = 0) {
    const ok = await this.eval<boolean>(`(() => {
      const c = ${this.control(label, nth)}
      if (!c || c.tagName !== 'SELECT') return false
      const o = [...c.options].find((x) => x.text.trim() === ${JSON.stringify(optionText)} || x.text.trim().startsWith(${JSON.stringify(optionText)}))
      if (!o) return false
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(c, o.value)
      c.dispatchEvent(new Event('input', { bubbles: true }))
      c.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    if (!ok) throw new Error(`No select "${label}" with the option "${optionText}"`)
  }
  async check(label: string, on = true, nth = 0) {
    const ok = await this.eval<boolean>(`(() => {
      const c = ${this.control(label, nth)}
      if (!c) return false
      if (c.checked !== ${on}) c.click()
      return true
    })()`)
    if (!ok) throw new Error(`No checkbox labelled "${label}"`)
  }
  /** Clicks the nth visible button, link or summary whose words are `text` (exact, else starting with it). */
  async click(text: string, o: { nth?: number; within?: string } = {}) {
    const ok = await this.eval<boolean>(`(() => {
      const root = ${o.within ? `document.querySelector(${JSON.stringify(o.within)})` : 'document'}
      if (!root) return false
      const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
      const want = ${JSON.stringify(text)}
      const all = [...root.querySelectorAll('button, a, summary, [role="button"], input[type="submit"]')].filter((e) => e.offsetParent !== null || e.tagName === 'SUMMARY')
      const exact = all.filter((e) => norm(e.innerText || e.value) === want || norm(e.getAttribute('aria-label')) === want)
      const list = exact.length ? exact : all.filter((e) => norm(e.innerText || e.value).startsWith(want))
      const el = list[${o.nth ?? 0}]
      if (!el || el.disabled) return false
      el.scrollIntoView({ block: 'center' })
      el.click()
      return true
    })()`)
    if (!ok) throw new Error(`No enabled button or link "${text}"`)
  }
  async upload(selector: string, file: string) {
    const { root } = await this.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 1 })
    const { nodeId } = await this.send<{ nodeId: number }>('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) throw new Error(`No file field ${selector}`)
    await this.send('DOM.setFileInputFiles', { nodeId, files: [file] })
  }
  /** A screenshot of the whole page (up to `maxHeight`), at the current width. */
  async screenshot(maxHeight = 4000): Promise<{ data: Buffer; width: number; height: number; scrollWidth: number }> {
    const size = await this.eval<{ h: number; sw: number }>('({ h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), sw: document.documentElement.scrollWidth })')
    const height = Math.min(maxHeight, Math.max(this.height, size.h))
    // The window is made as tall as the page for the picture (fixed and sticky parts such as the sidebar then sit where a person sees
    // them), and set back afterwards.
    const { width: w, height: h } = { width: this.width, height: this.height }
    if (height > h) {
      await this.send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: 1, mobile: w < 768, screenWidth: w, screenHeight: height })
      await sleep(400)
    }
    const r = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height, scale: 1 } })
    if (height > h) await this.viewport(w, h)
    return { data: Buffer.from(r.data, 'base64'), width: w, height, scrollWidth: size.sw }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
