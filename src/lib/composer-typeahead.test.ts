import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  COMPOSER_TYPEAHEAD_COMPOSITION_GRACE_MS,
  armComposerTypeahead,
  hasComposerTypeahead,
  resetComposerTypeaheadForTests,
  subscribeComposerTypeahead,
  takeComposerTypeahead,
} from "./composer-typeahead"

/** 最新的接键框（组合中又新建时，旧的还在等 compositionend）。 */
function catcher(): HTMLTextAreaElement | null {
  const all = document.querySelectorAll<HTMLTextAreaElement>(
    "textarea[data-composer-typeahead]"
  )
  return all.length ? all[all.length - 1] : null
}

function type(text: string) {
  const el = catcher()!
  el.value += text
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

describe("composer typeahead（#1302 新建会话后马上打字）", () => {
  let button: HTMLButtonElement
  beforeEach(() => {
    button = document.createElement("button")
    document.body.appendChild(button)
    button.focus()
  })
  afterEach(() => {
    resetComposerTypeaheadForTests()
    vi.useRealTimers()
    document.body.innerHTML = ""
  })

  it("arm 后焦点立刻落到接键框，take 拿回打的字并撤掉接键框", () => {
    armComposerTypeahead("tab-1")
    expect(document.activeElement).toBe(catcher())
    type("ABC")
    const got: string[] = []
    const taken = takeComposerTypeahead("tab-1", (t) => got.push(t))
    expect(taken.claimed).toBe(true)
    expect(got).toEqual(["ABC"])
    expect(catcher()).toBeNull()
    expect(hasComposerTypeahead("tab-1")).toBe(false)
  })

  it("别的标签拿不走", () => {
    armComposerTypeahead("tab-1")
    type("x")
    const onText = vi.fn()
    expect(takeComposerTypeahead("tab-2", onText).claimed).toBe(false)
    expect(onText).not.toHaveBeenCalled()
    expect(catcher()).not.toBeNull()
  })

  it("回车不提交也不换行", () => {
    armComposerTypeahead("tab-1")
    type("hi")
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    })
    catcher()!.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
  })

  it("Esc 撤掉接键框、焦点还回去，字仍然留给那个标签", () => {
    armComposerTypeahead("tab-1")
    type("AB")
    catcher()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )
    expect(catcher()).toBeNull()
    expect(document.activeElement).toBe(button)
    const onText = vi.fn()
    takeComposerTypeahead("tab-1", onText, { focused: true })
    expect(onText).toHaveBeenCalledWith("AB")
  })

  it("Esc / 点别处撤掉以后，输入框准备好时的自动聚焦不交字、不抢焦点", () => {
    for (const dismiss of ["esc", "click"] as const) {
      armComposerTypeahead("tab-1")
      type("AB")
      if (dismiss === "esc") {
        catcher()!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        )
      } else {
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
      }
      // 自动聚焦来拿：认领（调用方据此不聚焦），但不交字。
      const auto = vi.fn()
      expect(takeComposerTypeahead("tab-1", auto).claimed).toBe(true)
      expect(auto).not.toHaveBeenCalled()
      expect(hasComposerTypeahead("tab-1")).toBe(true)
      // 用户自己点回输入框时再交。
      const onText = vi.fn()
      takeComposerTypeahead("tab-1", onText, { focused: true })
      expect(onText).toHaveBeenCalledWith("AB")
      expect(hasComposerTypeahead("tab-1")).toBe(false)
    }
  })

  it("撤掉以后只挡一次自动聚焦：之后再切回这个标签照常聚焦并交字", () => {
    armComposerTypeahead("tab-1")
    type("AB")
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    const first = vi.fn()
    takeComposerTypeahead("tab-1", first)
    expect(first).not.toHaveBeenCalled()
    const second = vi.fn()
    expect(takeComposerTypeahead("tab-1", second).claimed).toBe(true)
    expect(second).toHaveBeenCalledWith("AB")
  })

  it("组合中又新建了别的会话：等组合确认，给上一个会话记下确认后的字", () => {
    armComposerTypeahead("tab-1")
    const el = catcher()!
    el.value = "不要用工具，"
    el.dispatchEvent(new CompositionEvent("compositionstart"))
    el.value = "不要用工具，zhijie"
    armComposerTypeahead("tab-2")
    expect(catcher()?.getAttribute("data-composer-typeahead")).toBe("tab-2")
    expect(document.activeElement).toBe(catcher())
    // 旧接键框失焦后浏览器确认组合。
    el.value = "不要用工具，直接"
    el.dispatchEvent(new CompositionEvent("compositionend"))
    expect(el.isConnected).toBe(false)
    const onText = vi.fn()
    expect(takeComposerTypeahead("tab-1", onText).claimed).toBe(true)
    expect(onText).toHaveBeenCalledWith("不要用工具，直接")
    expect(catcher()?.getAttribute("data-composer-typeahead")).toBe("tab-2")
  })

  it("组合中又新建了别的会话、一直等不到 compositionend：只记组合前的字", () => {
    vi.useFakeTimers()
    armComposerTypeahead("tab-1")
    const el = catcher()!
    el.value = "不要"
    el.dispatchEvent(new CompositionEvent("compositionstart"))
    el.value = "不要yong"
    armComposerTypeahead("tab-2")
    vi.advanceTimersByTime(COMPOSER_TYPEAHEAD_COMPOSITION_GRACE_MS + 1)
    expect(el.isConnected).toBe(false)
    const onText = vi.fn()
    takeComposerTypeahead("tab-1", onText)
    expect(onText).toHaveBeenCalledWith("不要")
  })

  it("组合中又给同一个会话新建：确认后的字接在新接键框的字前面", () => {
    armComposerTypeahead("tab-1")
    const el = catcher()!
    el.value = "不要"
    el.dispatchEvent(new CompositionEvent("compositionstart"))
    el.value = "不要yong"
    armComposerTypeahead("tab-1")
    type("具")
    el.value = "不要用工"
    el.dispatchEvent(new CompositionEvent("compositionend"))
    const onText = vi.fn()
    takeComposerTypeahead("tab-1", onText)
    expect(onText).toHaveBeenCalledWith("不要用工具")
  })

  it("输入框过了好几秒还没准备好：接键框不撤，接着收字", () => {
    vi.useFakeTimers()
    armComposerTypeahead("tab-1")
    type("AB")
    vi.advanceTimersByTime(10_000)
    expect(catcher()).not.toBeNull()
    expect(document.activeElement).toBe(catcher())
    type("CD")
    const onText = vi.fn()
    takeComposerTypeahead("tab-1", onText)
    expect(onText).toHaveBeenCalledWith("ABCD")
  })

  it("点了别处就撤掉，不抢焦点", () => {
    armComposerTypeahead("tab-1")
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    expect(catcher()).toBeNull()
  })

  it("输入法组合中等 compositionend 再交出去", () => {
    armComposerTypeahead("tab-1")
    const el = catcher()!
    el.dispatchEvent(new CompositionEvent("compositionstart"))
    el.value = "ni"
    const onText = vi.fn()
    expect(takeComposerTypeahead("tab-1", onText).claimed).toBe(true)
    expect(onText).not.toHaveBeenCalled()
    el.value = "你"
    el.dispatchEvent(new CompositionEvent("compositionend"))
    expect(onText).toHaveBeenCalledWith("你")
    expect(catcher()).toBeNull()
  })

  it("撤掉以后再次新建同一个会话：没拿走的字放回接键框，接着往后打", () => {
    armComposerTypeahead("tab-1")
    type("不要用工具，")
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    expect(catcher()).toBeNull()
    armComposerTypeahead("tab-1")
    type("直接回复")
    const onText = vi.fn()
    takeComposerTypeahead("tab-1", onText)
    expect(onText).toHaveBeenCalledWith("不要用工具，直接回复")
  })

  it("新建了别的会话，上一个会话没拿走的字仍然留给它", () => {
    armComposerTypeahead("tab-1")
    type("AB")
    catcher()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )
    armComposerTypeahead("tab-2")
    const onText = vi.fn()
    expect(
      takeComposerTypeahead("tab-1", onText, { focused: true }).claimed
    ).toBe(true)
    expect(onText).toHaveBeenCalledWith("AB")
    expect(catcher()?.getAttribute("data-composer-typeahead")).toBe("tab-2")
  })

  it("组合中点了别处：等组合确认再撤，记下确认后的字，不记半截拼音", () => {
    armComposerTypeahead("tab-1")
    const el = catcher()!
    el.value = "不要用工具，"
    el.dispatchEvent(new CompositionEvent("compositionstart"))
    el.value = "不要用工具，zhijie"
    const pending = vi.fn()
    expect(takeComposerTypeahead("tab-1", pending).claimed).toBe(true)
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    // 失焦后浏览器确认组合、发 compositionend。
    el.value = "不要用工具，直接"
    el.dispatchEvent(new CompositionEvent("compositionend"))
    expect(catcher()).toBeNull()
    // 点了别处，自动聚焦那次等着的交接不再接，免得抢焦点。
    expect(pending).not.toHaveBeenCalled()
    const onText = vi.fn()
    expect(
      takeComposerTypeahead("tab-1", onText, { focused: true }).claimed
    ).toBe(true)
    expect(onText).toHaveBeenCalledWith("不要用工具，直接")
  })

  it("组合中点了别处、一直等不到 compositionend：只记组合前的字", () => {
    vi.useFakeTimers()
    armComposerTypeahead("tab-1")
    const el = catcher()!
    el.value = "不要"
    el.dispatchEvent(new CompositionEvent("compositionstart"))
    el.value = "不要yong"
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    vi.advanceTimersByTime(COMPOSER_TYPEAHEAD_COMPOSITION_GRACE_MS + 1)
    expect(catcher()).toBeNull()
    const onText = vi.fn()
    takeComposerTypeahead("tab-1", onText, { focused: true })
    expect(onText).toHaveBeenCalledWith("不要")
  })

  it("组合中点回了输入框：等组合确认后把确认的字交给它", () => {
    armComposerTypeahead("tab-1")
    const el = catcher()!
    el.dispatchEvent(new CompositionEvent("compositionstart"))
    el.value = "ni"
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    // 输入框拿到焦点后来领（不挪焦点的调用方）。
    const onText = vi.fn()
    expect(
      takeComposerTypeahead("tab-1", onText, { focused: true }).claimed
    ).toBe(true)
    expect(onText).not.toHaveBeenCalled()
    el.value = "你"
    el.dispatchEvent(new CompositionEvent("compositionend"))
    expect(onText).toHaveBeenCalledWith("你")
    expect(catcher()).toBeNull()
    expect(hasComposerTypeahead("tab-1")).toBe(false)
  })

  it("arm 时通知订阅者", () => {
    const listener = vi.fn()
    subscribeComposerTypeahead(listener)
    armComposerTypeahead("tab-9")
    expect(listener).toHaveBeenCalledWith("tab-9")
  })

  it("触屏上不接（聚焦会弹软键盘）", () => {
    const spy = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          media: query,
          matches: query === "(pointer: coarse)",
        }) as unknown as MediaQueryList
    )
    armComposerTypeahead("tab-1")
    expect(catcher()).toBeNull()
    expect(document.activeElement).toBe(button)
    spy.mockRestore()
  })
})
