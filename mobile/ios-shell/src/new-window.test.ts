import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

// new_window.js 由 Rust 的 include_str! 原样注入到每个页面。这里把它当成函数体执行，
// 传进一个假的 window（location.assign 和原来的 open 换成 mock），真实的 jsdom document 用来派发点击。
const source = readFileSync(path.join(__dirname, "new_window.js"), "utf8")

const SERVER = "https://team.example.com/workspace"

function install(href = SERVER) {
  const assign = vi.fn()
  const originalOpen = vi.fn(() => null)
  const listeners: Array<(event: Event) => void> = []
  const fakeWindow = {
    location: { href, assign },
    open: originalOpen as (...args: unknown[]) => unknown,
    document,
    addEventListener: (type: string, fn: (event: Event) => void) => {
      if (type === "click") listeners.push(fn)
    },
  }
  new Function("window", source)(fakeWindow)
  // 模拟冒泡到 window：先让页面自己的处理跑完（document 上），再交给脚本挂在 window 上的
  const click = (el: Element, prevent = false) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    Object.defineProperty(event, "target", { value: el })
    if (prevent) event.preventDefault()
    for (const fn of listeners) fn(event)
    return event
  }
  return { fakeWindow, assign, originalOpen, click }
}

function link(href: string, target?: string) {
  const a = document.createElement("a")
  a.setAttribute("href", href)
  if (target !== undefined) a.setAttribute("target", target)
  const span = document.createElement("span")
  a.appendChild(span)
  document.body.appendChild(a)
  return { a, span }
}

beforeEach(() => {
  document.body.innerHTML = ""
})

describe("新窗口脚本", () => {
  it("window.open 打开别的网站时改成在当前网页视图里导航，交给导航规则", () => {
    const { fakeWindow, assign, originalOpen } = install()
    const result = fakeWindow.open(
      "https://docs.example.org/guide",
      "_blank",
      "noreferrer"
    )
    expect(assign).toHaveBeenCalledWith("https://docs.example.org/guide")
    expect(originalOpen).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it("window.open 同源地址或空地址照旧交给原来的 window.open", () => {
    const { fakeWindow, assign, originalOpen } = install()
    fakeWindow.open("/project-boot", "project-boot")
    fakeWindow.open("", "reserved")
    fakeWindow.open()
    expect(assign).not.toHaveBeenCalled()
    expect(originalOpen).toHaveBeenCalledTimes(3)
    expect(originalOpen).toHaveBeenCalledWith("/project-boot", "project-boot")
  })

  it("window.open 非 http/https 地址不导航", () => {
    const { fakeWindow, assign } = install()
    fakeWindow.open("mailto:someone@example.com")
    fakeWindow.open("javascript:alert(1)")
    expect(assign).not.toHaveBeenCalled()
  })

  it("点 target=_blank 的外站链接：拦下默认行为，在当前网页视图里导航", () => {
    const { assign, click } = install()
    const { span } = link("https://docs.example.org/a", "_blank")
    const event = click(span)
    expect(event.defaultPrevented).toBe(true)
    expect(assign).toHaveBeenCalledWith("https://docs.example.org/a")
  })

  it("普通链接、同源的新窗口链接、页面自己已经处理过的点击都不管", () => {
    const { assign, click } = install()
    expect(click(link("https://docs.example.org/b").a).defaultPrevented).toBe(
      false
    )
    expect(
      click(link("https://docs.example.org/c", "_self").a).defaultPrevented
    ).toBe(false)
    expect(click(link("/workspace?x=1", "_blank").a).defaultPrevented).toBe(
      false
    )
    // 例如外链确认框：页面先 preventDefault，确认以后自己调 window.open
    click(link("https://docs.example.org/d", "_blank").a, true)
    expect(assign).not.toHaveBeenCalled()
  })
})
