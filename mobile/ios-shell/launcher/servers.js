// coteam iOS 壳启动页的数据和规则：服务器地址怎么补全、存在哪、上次打开的是哪个。
// 全部是纯函数或只碰传进来的 storage，方便 vitest 直接测（见 launcher.test.ts）。

/** 已保存的服务器列表（JSON 字符串数组，存启动页自己的 localStorage） */
export const SERVERS_KEY = "coteam.servers"
/** 上次打开的服务器地址 */
export const LAST_SERVER_KEY = "coteam.lastServer"
/** 这次启动已经自动打开过上次的服务器（存 sessionStorage，应用重新启动就没了） */
export const AUTO_OPENED_KEY = "coteam.autoOpened"

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * 主机名是不是 IP 或本地名字（这些补 http，其他补 https）：
 * IPv4、IPv6（方括号）、localhost、没有点的单个名字、.local 结尾的名字。
 * @param {string} host 不带端口的主机名
 */
export function isLocalHost(host) {
  const h = host.toLowerCase()
  if (h.startsWith("[")) return true
  if (IPV4.test(h)) return true
  if (h === "localhost" || h.endsWith(".localhost")) return true
  if (h.endsWith(".local")) return true
  return !h.includes(".")
}

/**
 * 把用户输入的地址整理成服务器地址：没写协议的，IP 或本地名字补 http://，其他补 https://；
 * 去掉末尾的斜杠。不是 http/https 地址、解析不了的返回 null。
 * @param {string} input
 * @returns {string | null}
 */
export function normalizeServerUrl(input) {
  let raw = String(input ?? "").trim()
  if (raw === "") return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // 主机名到第一个 / ? # 为止，再去掉端口
    const authority = raw.split(/[/?#]/, 1)[0]
    const host = authority.startsWith("[")
      ? authority.slice(0, authority.indexOf("]") + 1)
      : authority.replace(/:\d*$/, "")
    if (host === "") return null
    raw = (isLocalHost(host) ? "http://" : "https://") + raw
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (url.hostname === "") return null
  return url.href.replace(/\/+$/, "")
}

/**
 * 读已保存的服务器列表；存的东西坏了当成空列表。
 * @param {Storage} storage
 * @returns {string[]}
 */
export function loadServers(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(SERVERS_KEY) ?? "[]")
    return Array.isArray(parsed)
      ? parsed.filter((s) => typeof s === "string")
      : []
  } catch {
    return []
  }
}

/**
 * @param {Storage} storage
 * @param {string[]} servers
 */
function saveServers(storage, servers) {
  storage.setItem(SERVERS_KEY, JSON.stringify(servers))
}

/**
 * 按地址添加一个服务器，返回整理后的地址；地址不对返回 null。已经有了的不重复加。
 * @param {Storage} storage
 * @param {string} input
 * @returns {string | null}
 */
export function addServer(storage, input) {
  const url = normalizeServerUrl(input)
  if (url === null) return null
  const servers = loadServers(storage)
  if (!servers.includes(url)) saveServers(storage, [...servers, url])
  return url
}

/**
 * 删除一个服务器；删的是上次打开的那个，也一起忘掉。
 * @param {Storage} storage
 * @param {string} url
 */
export function removeServer(storage, url) {
  saveServers(
    storage,
    loadServers(storage).filter((s) => s !== url)
  )
  if (storage.getItem(LAST_SERVER_KEY) === url) {
    storage.removeItem(LAST_SERVER_KEY)
  }
}

/**
 * 上次打开的服务器；已经不在列表里的不算。
 * @param {Storage} storage
 * @returns {string | null}
 */
export function lastServer(storage) {
  const last = storage.getItem(LAST_SERVER_KEY)
  return last !== null && loadServers(storage).includes(last) ? last : null
}

/**
 * 记下这次打开的服务器。
 * @param {Storage} storage
 * @param {string} url
 */
export function rememberServer(storage, url) {
  storage.setItem(LAST_SERVER_KEY, url)
}

/**
 * 启动页加载时要不要直接打开上次的服务器：只在应用这次启动后第一次到启动页时打开。
 * 从服务器网页点「切换服务器」、或者返回手势回到启动页时，sessionStorage 里已经有标记，
 * 留在启动页让用户换。返回要打开的地址或 null，并在会话里记下已经自动打开过。
 * @param {Storage} storage localStorage
 * @param {Storage} session sessionStorage
 * @returns {string | null}
 */
export function serverToAutoOpen(storage, session) {
  if (session.getItem(AUTO_OPENED_KEY) !== null) return null
  session.setItem(AUTO_OPENED_KEY, "1")
  return lastServer(storage)
}
