// A very small DOM, just enough for react-dom/client to mount, update and unmount the live wall in Node (the repository has no DOM
// library and nothing may be installed). It is NOT a browser: no layout, no real events (tests do not click), no CSS. What it does:
// elements and text nodes in a tree, attributes, inline style, listeners kept per node, document.visibilityState with its event.
// Used by tests/unit/live-wall-react.test.tsx (P4-L1 review M-3: the React side of the wall's cleanup).

type Listener = (e: { type: string }) => void

class MiniNode {
  nodeType: number
  nodeName: string
  parentNode: MiniNode | null = null
  childNodes: MiniNode[] = []
  ownerDocument: MiniDocument
  private listeners = new Map<string, Set<Listener>>()
  constructor(nodeType: number, nodeName: string, doc: MiniDocument | null) {
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.ownerDocument = doc ?? (this as unknown as MiniDocument)
  }
  get firstChild() { return this.childNodes[0] ?? null }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null }
  get parentElement() { return this.parentNode }
  get nextSibling(): MiniNode | null {
    const p = this.parentNode
    if (!p) return null
    const i = p.childNodes.indexOf(this)
    return p.childNodes[i + 1] ?? null
  }
  appendChild<T extends MiniNode>(c: T): T {
    c.parentNode?.removeChild(c)
    this.childNodes.push(c)
    c.parentNode = this
    return c
  }
  insertBefore<T extends MiniNode>(c: T, ref: MiniNode | null): T {
    if (!ref) return this.appendChild(c)
    c.parentNode?.removeChild(c)
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c)
    c.parentNode = this
    return c
  }
  removeChild<T extends MiniNode>(c: T): T {
    const i = this.childNodes.indexOf(c)
    if (i >= 0) this.childNodes.splice(i, 1)
    c.parentNode = null
    return c
  }
  append(...nodes: MiniNode[]) { for (const n of nodes) this.appendChild(n) }
  remove() { this.parentNode?.removeChild(this) }
  contains(n: MiniNode | null): boolean {
    for (let x = n; x; x = x.parentNode) if (x === this) return true
    return false
  }
  getRootNode(): MiniNode {
    return this.parentNode ? this.parentNode.getRootNode() : this
  }
  addEventListener(type: string, l: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(l)
  }
  removeEventListener(type: string, l: Listener) { this.listeners.get(type)?.delete(l) }
  dispatchEvent(e: { type: string }) {
    for (const l of [...(this.listeners.get(e.type) ?? [])]) l(e)
    return true
  }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join('') }
  set textContent(v: string) {
    for (const c of [...this.childNodes]) this.removeChild(c)
    if (v) this.appendChild(this.ownerDocument.createTextNode(v))
  }
}

class MiniText extends MiniNode {
  data: string
  constructor(data: string, doc: MiniDocument) {
    super(3, '#text', doc)
    this.data = data
  }
  get nodeValue() { return this.data }
  set nodeValue(v: string) { this.data = v }
  override get textContent() { return this.data }
  override set textContent(v: string) { this.data = v }
}

class MiniComment extends MiniNode {
  data: string
  constructor(data: string, doc: MiniDocument) {
    super(8, '#comment', doc)
    this.data = data
  }
  override get textContent() { return '' }
}

export class MiniElement extends MiniNode {
  tagName: string
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  attributes = new Map<string, string>()
  style: Record<string, string> & { setProperty(k: string, v: string): void; removeProperty(k: string): void }
  constructor(tag: string, doc: MiniDocument) {
    super(1, tag.toUpperCase(), doc)
    this.tagName = tag.toUpperCase()
    const store: Record<string, string> = {}
    this.style = Object.assign(store, {
      setProperty: (k: string, v: string) => { store[k] = v },
      removeProperty: (k: string) => { delete store[k] },
    }) as MiniElement['style']
  }
  private ownValue: string | undefined
  selected = false
  defaultSelected = false
  disabled = false
  get value(): string { return this.ownValue ?? this.getAttribute('value') ?? (this.tagName === 'OPTION' ? this.textContent : '') }
  set value(v: string) { this.ownValue = String(v) }
  /** A <select>'s options (React reads them to mark the chosen one). */
  get options(): MiniElement[] { return this.findAll((e) => e.tagName === 'OPTION') }
  setAttribute(k: string, v: string) { this.attributes.set(k, String(v)) }
  getAttribute(k: string) { return this.attributes.get(k) ?? null }
  hasAttribute(k: string) { return this.attributes.has(k) }
  removeAttribute(k: string) { this.attributes.delete(k) }
  setAttributeNS(_ns: string, k: string, v: string) { this.setAttribute(k, v) }
  removeAttributeNS(_ns: string, k: string) { this.removeAttribute(k) }
  focus() { this.ownerDocument.activeElement = this }
  blur() {}
  querySelector() { return null }
  querySelectorAll() { return [] }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 } }
  /** Every element below this one (and this one) with `name`'s attribute equal to `value`. */
  findAll(pred: (e: MiniElement) => boolean): MiniElement[] {
    const out: MiniElement[] = []
    const walk = (n: MiniNode) => {
      if (n instanceof MiniElement && pred(n)) out.push(n)
      n.childNodes.forEach(walk)
    }
    walk(this)
    return out
  }
}

export class MiniDocument extends MiniNode {
  visibilityState: 'visible' | 'hidden' = 'visible'
  activeElement: MiniElement | null = null
  documentElement: MiniElement
  body: MiniElement
  head: MiniElement
  defaultView: unknown = null
  constructor() {
    super(9, '#document', null)
    this.documentElement = new MiniElement('html', this)
    this.head = new MiniElement('head', this)
    this.body = new MiniElement('body', this)
    this.appendChild(this.documentElement)
    this.documentElement.append(this.head, this.body)
  }
  createElement(tag: string) { return new MiniElement(tag, this) }
  createElementNS(_ns: string, tag: string) { return new MiniElement(tag, this) }
  createTextNode(data: string) { return new MiniText(data, this) }
  createComment(data: string) { return new MiniComment(data, this) }
  getElementById() { return null }
  querySelector() { return null }
}

/** A click on `el` as React sees it: one event that travels from `el` up to the document (React listens at the root). */
export function click(el: MiniElement): void {
  fire(el, 'click')
}

/** Any bubbling event (`change` after setting a select's value, for example). */
export function fire(el: MiniElement, type: string): void {
  const e = {
    type, target: el, srcElement: el, bubbles: true, cancelable: true, defaultPrevented: false, detail: 1, button: 0, timeStamp: Date.now(),
    cancelBubble: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.cancelBubble = true },
  }
  for (let n: MiniNode | null = el; n && !e.cancelBubble; n = n.parentNode) n.dispatchEvent(e)
}

/** Installs the mini DOM as globals (document, window, …) and returns the document and a function that removes it again. */
export function installMiniDom(): { document: MiniDocument; restore: () => void } {
  const g = globalThis as Record<string, unknown>
  const before = new Map(['document', 'window', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'].map((k) => [k, g[k]]))
  const document = new MiniDocument()
  // The window's own events (pagehide, …): a test fires them with window.dispatchEvent({ type }).
  const windowListeners = new Map<string, Set<(e: { type: string }) => void>>()
  const win: Record<string, unknown> = {
    document,
    location: { protocol: 'http:', host: 'app.test:3212', hostname: 'app.test', href: 'http://app.test:3212/live' },
    navigator: { userAgent: 'mini-dom' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener(type: string, l: (e: { type: string }) => void) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set())
      windowListeners.get(type)!.add(l)
    },
    removeEventListener(type: string, l: (e: { type: string }) => void) { windowListeners.get(type)?.delete(l) },
    dispatchEvent(e: { type: string }) {
      for (const l of [...(windowListeners.get(e.type) ?? [])]) l(e)
      return true
    },
    getSelection: () => null,
    HTMLElement: MiniElement,
    HTMLIFrameElement: class {},
    Element: MiniElement,
    Node: MiniNode,
    event: undefined,
  }
  document.defaultView = win
  Object.assign(g, { document, window: win, HTMLElement: MiniElement, HTMLIFrameElement: class {}, Element: MiniElement, Node: MiniNode, IS_REACT_ACT_ENVIRONMENT: true })
  return {
    document,
    restore: () => {
      for (const [k, v] of before) {
        if (v === undefined) delete g[k]
        else g[k] = v
      }
    },
  }
}
