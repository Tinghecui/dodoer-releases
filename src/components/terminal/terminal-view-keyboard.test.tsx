import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TerminalView } from "./terminal-view"
import type { TerminalEvent } from "@/lib/types"

const h = vi.hoisted(() => ({
  writes: [] as string[],
  resets: 0,
  fits: 0,
  emulators: 0,
  disposed: 0,
  snapshot: vi.fn(),
  spawn: vi.fn(),
  kill: vi.fn(async () => {}),
  write: vi.fn(async () => {}),
  resize: vi.fn(async () => {}),
  // The pane size a fit lands on; null leaves the emulator's size alone.
  pane: null as { cols: number; rows: number } | null,
  // While set, xterm "has not drawn" what was written: parse callbacks wait.
  holdParse: false,
  parsed: [] as (() => void)[],
  fontSize: 12,
  onData: null as ((data: string) => void) | null,
  onResize: null as ((size: { cols: number; rows: number }) => void) | null,
  handlers: new Map<string, (event: TerminalEvent) => void>(),
  waitForRegistration: null as ((channel: string) => Promise<void>) | null,
  ready: null as (() => void) | null,
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, args?: { code: number }) =>
    key === "processExitedWithCode"
      ? `Process exited (code ${args?.code})`
      : key,
}))
vi.mock("@/lib/api", () => ({
  terminalSnapshot: h.snapshot,
  terminalSpawn: h.spawn,
  terminalWrite: h.write,
  terminalResize: h.resize,
  terminalKill: h.kill,
}))
vi.mock("@/lib/platform", () => ({
  subscribe: async (channel: string, cb: (event: TerminalEvent) => void) => {
    h.handlers.set(channel, cb)
    if (h.waitForRegistration) await h.waitForRegistration(channel)
    return () => {
      h.handlers.delete(channel)
    }
  },
  onTransportReady: (cb: () => void) => {
    h.ready = cb
    return () => {
      h.ready = null
    }
  },
}))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100 }),
  useTerminalFont: () => ({
    terminalFontStack: "monospace",
    terminalFontSize: h.fontSize,
    terminalLigatures: false,
  }),
}))
vi.mock("@/hooks/use-open-url-target", () => ({
  useOpenUrlTarget: () => vi.fn(),
  isPrimaryModifier: () => false,
}))
vi.mock("@/hooks/use-platform", () => ({ detectPlatform: () => "linux" }))
vi.mock("@/lib/terminal/theme", () => ({ getTerminalTheme: () => ({}) }))
vi.mock("@/lib/browser/browser-prefs", () => ({ getBrowserPrefs: () => ({}) }))
vi.mock("@/components/terminal/terminal-link-menu", () => ({
  TerminalLinkMenu: () => null,
  terminalLinkClickOpensMenu: () => false,
}))
vi.mock("@/components/terminal/term-keybar", () => ({ TermKeybar: () => null }))
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      h.emulators++
    }
    options = { fontFamily: "", fontSize: 12, theme: {} }
    modes = { applicationCursorKeysMode: false }
    loadAddon(addon: { activate?: (term: unknown) => void }) {
      addon.activate?.(this)
    }
    open() {}
    attachCustomKeyEventHandler() {}
    onData(cb: (data: string) => void) {
      h.onData = cb
      return {
        dispose() {
          h.onData = null
        },
      }
    }
    cols = 80
    rows = 24
    resize(cols: number, rows: number) {
      if (cols === this.cols && rows === this.rows) return
      this.cols = cols
      this.rows = rows
      h.writes.push(`<resize ${cols}x${rows}>`)
      h.onResize?.({ cols, rows })
    }
    onResize(cb: (size: { cols: number; rows: number }) => void) {
      h.onResize = cb
      return {
        dispose() {
          h.onResize = null
        },
      }
    }
    write(data: string, parsed?: () => void) {
      if (data) h.writes.push(data)
      if (!parsed) return
      if (h.holdParse) h.parsed.push(parsed)
      else parsed()
    }
    reset() {
      h.resets++
      h.writes.push("<reset>")
    }
    dispose() {
      h.disposed++
    }
    focus() {}
  },
}))
vi.mock("@xterm/addon-ligatures", () => ({ LigaturesAddon: class {} }))
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    term: { resize: (cols: number, rows: number) => void } | null = null
    activate(term: { resize: (cols: number, rows: number) => void }) {
      this.term = term
    }
    fit() {
      h.fits++
      if (h.pane) this.term?.resize(h.pane.cols, h.pane.rows)
    }
  },
}))
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }))

// 手机上软键盘遮住底部 300px：只有真的订阅了可见区域（enabled=true）才拿得到。
vi.mock("@/hooks/use-visual-viewport", () => ({
  useVisualViewport: (enabled: boolean) => ({
    height: enabled ? 432 : null,
    offsetTop: 0,
    keyboardLift: enabled ? 300 : 0,
    keyboardOpen: enabled,
  }),
}))

const props = {
  terminalId: "terminal-1",
  workingDir: "/tmp",
  isActive: true,
  isVisible: true,
}

/** xterm 和键栏所在的那一列 flex 容器。 */
function termColumn(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("div.flex.h-full.flex-col")
  if (!el) throw new Error("找不到终端的 flex 列")
  return el
}

describe("TerminalView 软键盘弹起", () => {
  it("手机上收起快捷键栏后，终端仍然让出键盘遮住的高度", () => {
    const { container } = render(
      <TerminalView {...props} mobile keybarVisible={false} />
    )
    expect(termColumn(container).style.maxHeight).toBe("calc(100% - 300px)")
  })

  it("手机上快捷键栏显示时照旧让出键盘高度", () => {
    const { container } = render(
      <TerminalView {...props} mobile keybarVisible />
    )
    expect(termColumn(container).style.maxHeight).toBe("calc(100% - 300px)")
  })

  it("桌面布局不跟踪键盘、不限高", () => {
    const { container } = render(<TerminalView {...props} />)
    expect(termColumn(container).style.maxHeight).toBe("")
  })
})
