/**
 * 新建会话后马上打字的「接键框」（#1302）。
 *
 * 点「新建会话」或按 Ctrl+T 只是往标签状态里加一个草稿标签，新输入框要等
 * React 渲染、Tiptap 编辑器晚一拍建好（immediatelyRender: false）、再下一帧才
 * 拿到焦点。这几帧里焦点还在侧栏按钮、消息区这些不可编辑的元素上，打的字被
 * 浏览器直接丢掉。
 *
 * 这里在用户点击 / 按键的同一个事件里，同步放一个屏幕外的透明 textarea 并
 * 聚焦它，收下这段时间打的所有字（包括输入法上屏）；新输入框准备好时用
 * `takeComposerTypeahead(tabId, …)` 把字拿走、插进编辑器。
 *
 * - 回车不提交（还没连上就半截发出去更糟），只拦下来，让用户在输入框里再按。
 * - 不按时间撤：新输入框准备得再慢，这期间打的字也接着收，直到输入框来拿。
 * - 按 Esc、鼠标点了别处，接键框撤掉（Esc 把焦点还回去）；已经收下的字不丢，
 *   记在 `leftovers` 里留给那个标签：那个标签的输入框下次拿到焦点时补进去，
 *   再次给它新建会话时先放回接键框里接着打。
 * - 用户按 Esc、点别处撤掉的，记作「用户不要了」：随后输入框准备好时的自动
 *   聚焦不交字、也不聚焦（不把焦点从用户放的地方抢回来），只挡这一次；字等
 *   用户自己点回输入框时再补。
 * - 正在输入法组合时等 compositionend 再交出去，免得把半截拼音交过去；组合中
 *   被点别处打断、或又新建了一个会话的，也等组合确认（compositionend）再撤、
 *   记下确认后的字。
 */

/**
 * 组合中被点了别处、浏览器一直没发 compositionend 时，最多等多久就撤掉接键框；
 * 这时只记组合开始前的字，不记半截拼音。
 */
export const COMPOSER_TYPEAHEAD_COMPOSITION_GRACE_MS = 500

interface Catcher {
  tabId: string
  textarea: HTMLTextAreaElement | null
  previousFocus: Element | null
  composing: boolean
  /** 组合开始时 textarea 里已经确认的字。 */
  beforeComposition: string
  /** 组合中被点了别处：等组合确认就撤。 */
  releaseAfterComposition: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** 撤掉接键框以后剩下的字（没撤之前以 textarea.value 为准）。 */
  text: string
  cleanup: (() => void) | null
  /** 正在组合时有人来拿，等 compositionend 再交给它。 */
  pendingTake: ((text: string) => void) | null
}

let current: Catcher | null = null
/** 接键框撤掉了、还没交给输入框的字，按标签记。 */
const leftovers = new Map<string, string>()
/** 接键框被用户 Esc / 点别处撤掉的标签：下一次自动聚焦不交字、不抢焦点。 */
const dismissed = new Set<string>()
/** 又新建了会话时还在组合的旧接键框，等它的 compositionend 再撤。 */
const orphans = new Set<Catcher>()
const listeners = new Set<(tabId: string) => void>()

function isCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  )
}

function readText(c: Catcher): string {
  return c.textarea ? c.textarea.value : c.text
}

/**
 * 撤掉接键框。`keep` 为真时把字记进 `leftovers` 等那个标签来拿（交出去的时候
 * 为假）。`restoreFocus` 为真时把焦点还给原来的元素。`text` 给了时记它，不记
 * textarea 里现有的（组合没确认就撤时，丢掉半截拼音）。`byUser` 为真表示是
 * 用户 Esc / 点别处撤的，挡掉随后的一次自动聚焦。
 */
function release(
  c: Catcher,
  opts: {
    restoreFocus?: boolean
    keep?: boolean
    text?: string
    byUser?: boolean
  } = {}
) {
  const { restoreFocus = false, keep = true, text, byUser = false } = opts
  if (c.timer) clearTimeout(c.timer)
  c.timer = null
  c.cleanup?.()
  c.cleanup = null
  // 组合被打断时等着的那次交接不会再来了：字进 leftovers，输入框聚焦时来拿。
  c.pendingTake = null
  orphans.delete(c)
  if (current === c) current = null
  const textarea = c.textarea
  if (!textarea) return
  c.text = text ?? textarea.value
  c.textarea = null
  c.composing = false
  c.releaseAfterComposition = false
  if (keep && c.text) {
    const live = current
    if (live && live.tabId === c.tabId && live.textarea) {
      // 同一个标签已经又开了接键框（组合中又新建了一次）：这些字在前面。
      const el = live.textarea
      el.value = c.text + el.value
      el.setSelectionRange(el.value.length, el.value.length)
    } else {
      leftovers.set(c.tabId, (leftovers.get(c.tabId) ?? "") + c.text)
    }
  }
  if (byUser) dismissed.add(c.tabId)
  const hadFocus = document.activeElement === textarea
  textarea.remove()
  if (restoreFocus && hadFocus) {
    const prev = c.previousFocus
    if (prev instanceof HTMLElement && prev.isConnected) {
      prev.focus({ preventScroll: true })
    }
  }
}

function deliver(c: Catcher, onText: (text: string) => void) {
  const text = readText(c)
  release(c, { keep: false })
  onText(text)
}

/**
 * 在用户发起新建会话的同一个事件里调用：立刻把焦点交给接键框，收下新输入框
 * 准备好之前打的字。触屏上不接（聚焦会弹出软键盘，而且新输入框在触屏上也
 * 不自动聚焦）。接键框不按时间撤，等输入框来拿。再次调用会撤掉上一次的接键框，上一次没拿走的字留给它的
 * 标签；同一个标签还有没拿走的字时，先放回新的接键框里，接着往后打。
 */
export function armComposerTypeahead(tabId: string | null | undefined) {
  if (!tabId || typeof document === "undefined") return
  if (isCoarsePointer()) return
  if (current) {
    const prev = current
    if (prev.composing) {
      // 还在组合：textarea 里是半截拼音。新接键框一聚焦，旧的失焦，浏览器会
      // 确认或取消组合并发 compositionend，到那时再撤、记下确认后的字；等不来
      // 就只记组合前的字。
      current = null
      prev.pendingTake = null
      orphans.add(prev)
      if (!prev.releaseAfterComposition) {
        prev.releaseAfterComposition = true
        prev.timer = setTimeout(() => {
          prev.timer = null
          if (orphans.has(prev)) {
            release(prev, { text: prev.beforeComposition })
          }
        }, COMPOSER_TYPEAHEAD_COMPOSITION_GRACE_MS)
      }
    } else {
      release(prev)
    }
  }
  dismissed.delete(tabId)
  const textarea = document.createElement("textarea")
  const left = leftovers.get(tabId)
  if (left) {
    textarea.value = left
    leftovers.delete(tabId)
  }
  textarea.setAttribute("aria-hidden", "true")
  textarea.setAttribute("tabindex", "-1")
  textarea.setAttribute("autocomplete", "off")
  textarea.setAttribute("data-composer-typeahead", tabId)
  // 屏幕外、透明，但不能 display:none / visibility:hidden，否则拿不到焦点。
  Object.assign(textarea.style, {
    position: "fixed",
    top: "0",
    left: "-10000px",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
  })
  const c: Catcher = {
    tabId,
    textarea,
    previousFocus: document.activeElement,
    composing: false,
    beforeComposition: "",
    releaseAfterComposition: false,
    timer: null,
    text: "",
    cleanup: null,
    pendingTake: null,
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || c.composing) return
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      release(c, { restoreFocus: true, byUser: true })
      return
    }
    if (e.key === "Enter") {
      // 不提交、不换行：回车留给用户在真正的输入框里再按。
      e.preventDefault()
      e.stopPropagation()
    }
  }
  const onCompositionStart = () => {
    c.composing = true
    c.beforeComposition = textarea.value
  }
  const onCompositionEnd = () => {
    c.composing = false
    // 这时 textarea 里是确认后的字。点别处以后登记的交接只会是已经拿到焦点
    // 的输入框（用户点回了输入框），直接交给它。
    const take = c.pendingTake
    c.pendingTake = null
    if (take) {
      deliver(c, take)
      return
    }
    // 组合中被点了别处（或又新建了会话）：记下确认后的字再撤。
    if (c.releaseAfterComposition) release(c, { byUser: current === c })
  }
  const onPointerDown = (e: Event) => {
    if (e.target === textarea) return
    if (current !== c) return
    if (c.composing) {
      // 组合中：textarea 里还是半截拼音，点别处让它失焦后浏览器会确认或取消
      // 组合并发 compositionend，到那时再撤。等不来就只记组合前的字。
      if (c.releaseAfterComposition) return
      c.releaseAfterComposition = true
      // 等着的交接不会再来了（用户点了别处，不把焦点抢回输入框）。
      c.pendingTake = null
      c.timer = setTimeout(() => {
        c.timer = null
        if (current === c && c.releaseAfterComposition) {
          release(c, { text: c.beforeComposition, byUser: true })
        }
      }, COMPOSER_TYPEAHEAD_COMPOSITION_GRACE_MS)
      return
    }
    // 用户点了别处：焦点归他点的地方，不抢回来。
    release(c, { byUser: true })
  }
  textarea.addEventListener("keydown", onKeyDown)
  textarea.addEventListener("compositionstart", onCompositionStart)
  textarea.addEventListener("compositionend", onCompositionEnd)
  document.addEventListener("pointerdown", onPointerDown, true)
  document.addEventListener("mousedown", onPointerDown, true)
  c.cleanup = () => {
    textarea.removeEventListener("keydown", onKeyDown)
    textarea.removeEventListener("compositionstart", onCompositionStart)
    textarea.removeEventListener("compositionend", onCompositionEnd)
    document.removeEventListener("pointerdown", onPointerDown, true)
    document.removeEventListener("mousedown", onPointerDown, true)
  }
  document.body.appendChild(textarea)
  textarea.focus({ preventScroll: true })
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  current = c
  for (const listener of listeners) listener(tabId)
}

/** 有没有给这个标签接着的字（或正开着的接键框、刚被用户撤掉的记号）。 */
export function hasComposerTypeahead(tabId: string | null | undefined) {
  return (
    !!tabId &&
    (current?.tabId === tabId || leftovers.has(tabId) || dismissed.has(tabId))
  )
}

/**
 * 新输入框准备好时调用：把给这个标签接下的字交给 `onText`（可能是空串），
 * 并撤掉接键框；没有给这个标签的接键框时不调用，返回 false。正在输入法组合时
 * 等组合结束再交（不能这时把焦点挪走，会打断组合）。`cancel` 在还没交出去时
 * 取消，字继续留着。
 *
 * `focused`：调用方的输入框已经拿到焦点（用户点回了输入框），交字不会挪焦点。
 * 组合中被点了别处、正等组合确认时，只有这种调用方等得到确认后的字；别的
 * （自动聚焦）不再登记，免得把焦点从用户点的地方抢回来，字留进 `leftovers`。
 */
export function takeComposerTypeahead(
  tabId: string | null | undefined,
  onText: (text: string) => void,
  opts: { focused?: boolean } = {}
): { claimed: boolean; cancel: () => void } {
  if (!tabId) return { claimed: false, cancel: () => {} }
  const c = current
  if (!c || c.tabId !== tabId) {
    if (dismissed.delete(tabId) && !opts.focused) {
      // 用户刚 Esc / 点别处撤掉：这次自动聚焦不交字、调用方也不聚焦。
      return { claimed: true, cancel: () => {} }
    }
    const left = leftovers.get(tabId)
    if (left === undefined) return { claimed: false, cancel: () => {} }
    leftovers.delete(tabId)
    onText(left)
    return { claimed: true, cancel: () => {} }
  }
  if (c.composing) {
    if (c.releaseAfterComposition && !opts.focused) {
      return { claimed: true, cancel: () => {} }
    }
    c.pendingTake = onText
    return {
      claimed: true,
      cancel: () => {
        if (c.pendingTake === onText) c.pendingTake = null
      },
    }
  }
  deliver(c, onText)
  return { claimed: true, cancel: () => {} }
}

/** 有接键框为某个标签打开时通知（已经准备好的输入框据此立刻来拿）。 */
export function subscribeComposerTypeahead(
  listener: (tabId: string) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 测试用：撤掉一切。 */
export function resetComposerTypeaheadForTests() {
  if (current) release(current, { keep: false })
  for (const c of [...orphans]) release(c, { keep: false })
  current = null
  leftovers.clear()
  dismissed.clear()
  listeners.clear()
}
