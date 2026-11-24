import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { start } from "./launcher.js"
import {
  AUTO_OPENED_KEY,
  addServer,
  lastServer,
  loadServers,
  normalizeServerUrl,
  rememberServer,
  removeServer,
  serverToAutoOpen,
} from "./servers.js"

const html = readFileSync(path.join(__dirname, "index.html"), "utf8")

describe("地址规则 normalizeServerUrl", () => {
  it("写了协议的原样保留，去掉末尾斜杠", () => {
    expect(normalizeServerUrl("https://team.example.com/")).toBe(
      "https://team.example.com"
    )
    expect(normalizeServerUrl("http://team.example.com")).toBe(
      "http://team.example.com"
    )
    expect(normalizeServerUrl("  HTTPS://Team.Example.com//  ")).toBe(
      "https://team.example.com"
    )
  })

  it("没写协议的域名补 https", () => {
    expect(normalizeServerUrl("team.example.com")).toBe(
      "https://team.example.com"
    )
    expect(normalizeServerUrl("team.example.com:8443")).toBe(
      "https://team.example.com:8443"
    )
  })

  it("没写协议的 IP 补 http", () => {
    expect(normalizeServerUrl("192.0.2.10:3080")).toBe("http://192.0.2.10:3080")
    expect(normalizeServerUrl("192.0.2.10")).toBe("http://192.0.2.10")
    expect(normalizeServerUrl("[2001:db8::1]:3080")).toBe(
      "http://[2001:db8::1]:3080"
    )
  })

  it("没写协议的本地名字补 http", () => {
    expect(normalizeServerUrl("localhost:3080")).toBe("http://localhost:3080")
    expect(normalizeServerUrl("devbox")).toBe("http://devbox")
    expect(normalizeServerUrl("devbox.local:3080/")).toBe(
      "http://devbox.local:3080"
    )
  })

  it("带路径的保留路径，去掉末尾斜杠", () => {
    expect(normalizeServerUrl("team.example.com/coteam/")).toBe(
      "https://team.example.com/coteam"
    )
    expect(normalizeServerUrl("http://192.0.2.10:3080/a/b///")).toBe(
      "http://192.0.2.10:3080/a/b"
    )
  })

  it("空的、别的协议、解析不了的返回 null", () => {
    expect(normalizeServerUrl("")).toBeNull()
    expect(normalizeServerUrl("   ")).toBeNull()
    expect(normalizeServerUrl("ftp://files.example.com")).toBeNull()
    expect(normalizeServerUrl("/only/path")).toBeNull()
    expect(normalizeServerUrl("https://")).toBeNull()
  })
})

describe("服务器列表的存储", () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it("添加、去重、删除；删掉上次打开的那个也一起忘掉", () => {
    expect(addServer(localStorage, "team.example.com/")).toBe(
      "https://team.example.com"
    )
    expect(addServer(localStorage, "https://team.example.com")).toBe(
      "https://team.example.com"
    )
    expect(addServer(localStorage, "devbox:3080")).toBe("http://devbox:3080")
    expect(addServer(localStorage, "ftp://x.example.com")).toBeNull()
    expect(loadServers(localStorage)).toEqual([
      "https://team.example.com",
      "http://devbox:3080",
    ])
    rememberServer(localStorage, "http://devbox:3080")
    expect(lastServer(localStorage)).toBe("http://devbox:3080")
    removeServer(localStorage, "http://devbox:3080")
    expect(loadServers(localStorage)).toEqual(["https://team.example.com"])
    expect(lastServer(localStorage)).toBeNull()
  })

  it("存的数据坏了当成空列表", () => {
    localStorage.setItem("coteam.servers", "{not json")
    expect(loadServers(localStorage)).toEqual([])
  })

  it("只在这次启动第一次到启动页时自动打开上次的服务器", () => {
    addServer(localStorage, "team.example.com")
    rememberServer(localStorage, "https://team.example.com")
    expect(serverToAutoOpen(localStorage, sessionStorage)).toBe(
      "https://team.example.com"
    )
    // 切换服务器回到启动页：同一个会话里不再自动打开
    expect(serverToAutoOpen(localStorage, sessionStorage)).toBeNull()
    // 应用重新启动（sessionStorage 清空）又会打开
    sessionStorage.clear()
    expect(serverToAutoOpen(localStorage, sessionStorage)).toBe(
      "https://team.example.com"
    )
  })
})

describe("启动页界面", () => {
  function mount() {
    document.documentElement.innerHTML = html
    const assign = vi.fn()
    const win = {
      document,
      localStorage,
      sessionStorage,
      location: { assign },
    } as unknown as Window
    const opened = start(win)
    return { assign, opened }
  }

  function serverButtons() {
    return [...document.querySelectorAll<HTMLButtonElement>("button.open")]
  }

  function addViaForm(address: string) {
    const input = document.getElementById("address") as HTMLInputElement
    input.value = address
    const form = document.getElementById("add-form") as HTMLFormElement
    form.dispatchEvent(new Event("submit", { cancelable: true }))
  }

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it("没有服务器时显示空状态；按地址添加后列出来", () => {
    const { opened } = mount()
    expect(opened).toBeNull()
    expect(document.getElementById("empty")?.hidden).toBe(false)
    addViaForm("team.example.com/")
    expect(serverButtons().map((b) => b.dataset.url)).toEqual([
      "https://team.example.com",
    ])
    expect(document.getElementById("empty")?.hidden).toBe(true)
    expect((document.getElementById("address") as HTMLInputElement).value).toBe(
      ""
    )
  })

  it("地址不对时提示，不加进列表", () => {
    mount()
    addViaForm("ftp://files.example.com")
    expect(serverButtons()).toHaveLength(0)
    const error = document.getElementById("error") as HTMLElement
    expect(error.hidden).toBe(false)
    expect(error.textContent).not.toBe("")
  })

  it("点一个服务器：记住它，并在同一个网页视图里打开它", () => {
    addServer(localStorage, "team.example.com")
    addServer(localStorage, "devbox:3080")
    const { assign } = mount()
    serverButtons()[1].click()
    expect(assign).toHaveBeenCalledWith("http://devbox:3080")
    expect(lastServer(localStorage)).toBe("http://devbox:3080")
  })

  it("删除按钮把服务器从列表里去掉", () => {
    addServer(localStorage, "team.example.com")
    addServer(localStorage, "devbox:3080")
    mount()
    document.querySelector<HTMLButtonElement>("button.remove")?.click()
    expect(serverButtons().map((b) => b.dataset.url)).toEqual([
      "http://devbox:3080",
    ])
    expect(loadServers(localStorage)).toEqual(["http://devbox:3080"])
  })

  it("同一主机的 http 和 https 两个服务器在列表里分得清", () => {
    addServer(localStorage, "http://team.example.com/coteam")
    addServer(localStorage, "https://team.example.com/coteam")
    mount()
    // 没有「上次打开」标记，按钮上的字就是显示出来的地址
    const labels = serverButtons().map((b) => b.textContent?.trim())
    expect(labels).toEqual([
      "http://team.example.com/coteam",
      "https://team.example.com/coteam",
    ])
    const removeLabels = [
      ...document.querySelectorAll<HTMLButtonElement>("button.remove"),
    ].map((b) => b.getAttribute("aria-label"))
    expect(new Set(removeLabels).size).toBe(2)
  })

  it("应用再次启动时直接打开上次的服务器", () => {
    addServer(localStorage, "team.example.com")
    rememberServer(localStorage, "https://team.example.com")
    const { assign, opened } = mount()
    expect(opened).toBe("https://team.example.com")
    expect(assign).toHaveBeenCalledWith("https://team.example.com")
  })

  it("从服务器回到启动页时留在启动页，可以手动换另一个", () => {
    addServer(localStorage, "team.example.com")
    addServer(localStorage, "second.example.net")
    rememberServer(localStorage, "https://team.example.com")
    sessionStorage.setItem(AUTO_OPENED_KEY, "1")
    const { assign, opened } = mount()
    expect(opened).toBeNull()
    expect(assign).not.toHaveBeenCalled()
    // 上次打开的那个有标记
    expect(serverButtons()[0].querySelector(".badge")).not.toBeNull()
    expect(serverButtons()[1].querySelector(".badge")).toBeNull()
    serverButtons()[1].click()
    expect(assign).toHaveBeenCalledWith("https://second.example.net")
    expect(lastServer(localStorage)).toBe("https://second.example.net")
  })

  it("页面入口不写内联脚本（CSP 是 default-src 'self'）", () => {
    expect(html).toMatch(/<script type="module" src="main\.js"><\/script>/)
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
  })
})
