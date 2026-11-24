// coteam iOS 壳的启动页：列出已保存的服务器，按地址添加、删除；点一个就在同一个网页视图里打开它，
// 壳的导航规则（src/navigation.rs）把它认成「选了这个服务器」。
// 应用每次启动后第一次到启动页时，直接打开上次的服务器。

import {
  addServer,
  lastServer,
  loadServers,
  rememberServer,
  removeServer,
  serverToAutoOpen,
} from "./servers.js"

/**
 * 在启动页上挂好界面。返回打开了的服务器地址（自动打开上次的服务器时），没打开返回 null。
 * @param {Window} win
 * @returns {string | null}
 */
export function start(win) {
  const doc = win.document
  const storage = win.localStorage

  /** @param {string} url */
  function open(url) {
    rememberServer(storage, url)
    win.location.assign(url)
  }

  const auto = serverToAutoOpen(storage, win.sessionStorage)
  if (auto !== null) {
    open(auto)
    return auto
  }

  const list = /** @type {HTMLUListElement} */ (doc.getElementById("servers"))
  const empty = /** @type {HTMLElement} */ (doc.getElementById("empty"))
  const form = /** @type {HTMLFormElement} */ (doc.getElementById("add-form"))
  const input = /** @type {HTMLInputElement} */ (doc.getElementById("address"))
  const error = /** @type {HTMLElement} */ (doc.getElementById("error"))

  function render() {
    const servers = loadServers(storage)
    const last = lastServer(storage)
    list.replaceChildren()
    empty.hidden = servers.length > 0
    for (const url of servers) {
      const item = doc.createElement("li")
      const openButton = doc.createElement("button")
      openButton.type = "button"
      openButton.className = "open"
      openButton.dataset.url = url
      // 显示完整地址（带协议）：同一主机、同一路径的 http 和 https 是两个服务器，要分得清
      openButton.textContent = url
      if (url === last) {
        const badge = doc.createElement("span")
        badge.className = "badge"
        badge.textContent = "上次打开"
        openButton.append(" ", badge)
      }
      openButton.addEventListener("click", () => open(url))
      const removeButton = doc.createElement("button")
      removeButton.type = "button"
      removeButton.className = "remove"
      removeButton.dataset.url = url
      removeButton.textContent = "删除"
      removeButton.setAttribute("aria-label", `删除 ${url}`)
      removeButton.addEventListener("click", () => {
        removeServer(storage, url)
        render()
      })
      item.append(openButton, removeButton)
      list.append(item)
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault()
    const added = addServer(storage, input.value)
    if (added === null) {
      error.textContent = "地址不对，请输入服务器地址，例如 team.example.com"
      error.hidden = false
      return
    }
    error.hidden = true
    input.value = ""
    render()
  })

  render()
  return null
}
