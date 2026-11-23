import { isIosShell } from "@/lib/transport/detect"
import type { FolderDetail } from "@/lib/types"

/**
 * 手机布局：宽度 767px 以下，或者粗指针（手指）且高度 500px 以下——后一条是
 * iPhone 横屏，宽度够了但屏幕很矮，桌面外壳摆不下。有鼠标的矮窗口、平板横屏
 * 仍走桌面布局。`useIsMobile` 用的也是这一条。
 */
export const MOBILE_LAYOUT_QUERY =
  "(max-width: 767px), (pointer: coarse) and (max-height: 500px)"

/** 回不去的时候回到的地方：工作区 */
export const IN_PAGE_HOME_PATH = "/workspace"

/**
 * 现在是不是手机布局（手机宽度，或者在 iOS 壳里）。不是 hook，给
 * `lib/api.ts` 这类非组件代码在点击时判断用（#1332）。
 */
export function isMobileLayout(): boolean {
  if (isIosShell()) return true
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false
  return window.matchMedia(MOBILE_LAYOUT_QUERY).matches
}

interface InPageRouter {
  push: (path: string) => void
  back: () => void
}

let inPageRouter: InPageRouter | null = null

/**
 * 根布局里的组件把 Next 的路由注册进来；`lib/` 里的代码拿不到 `useRouter`。
 * 返回注销函数。
 */
export function setInPageRouter(router: InPageRouter): () => void {
  inPageRouter = router
  return () => {
    if (inPageRouter === router) inPageRouter = null
  }
}

/**
 * 这个标签页里「在当前页打开」过的页面，记的是路径的第一段（`/settings`、
 * `/commit`），可以有好几个。页面要「关掉自己」时靠它认出自己是在当前页打开的，
 * 不看当时的宽度和 `window.opener`：打开以后把浏览器拉宽，或者工作区标签页本身
 * 是别的页面打开的（带 opener），都还是在当前页里，要返回而不是关掉整个标签页。
 * 只记第一段：在设置里切换分区（`/settings/general` → `/settings/appearance`）
 * 还是同一个页面。
 *
 * 放在 sessionStorage 里，在那一页上刷新以后还在；sessionStorage 用不了时退回
 * 内存。离开那个页面时不清（第 3 次返工）：按返回只退回上一个设置分区、用浏览器
 * 后退再前进回到那一页，都还在当前页打开的历史里。只有回到工作区
 * （{@link navigateInPage} 去 `/workspace`）时整个清空，那时往前的历史也没了。
 * `window.open` 另开的窗口会复制一份 sessionStorage，所以另开那一下把记录先藏起来
 * （{@link withoutInPageRecord}），新窗口复制到的是空的。
 */
const OPENED_IN_PAGE_KEY = "codeg.inPage.openedRoot"
const PENDING_FOLDER_KEY = "codeg.inPage.pendingFolder"

const memoryStore = new Map<string, string>()

function readStored(key: string): string | null {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      const value = window.sessionStorage.getItem(key)
      if (value !== null) return value
    }
  } catch {
    // 用不了就看内存
  }
  return memoryStore.get(key) ?? null
}

function writeStored(key: string, value: string | null): void {
  if (value === null) memoryStore.delete(key)
  else memoryStore.set(key, value)
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return
    if (value === null) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, value)
  } catch {
    // 只留在内存里
  }
}

/** 路径的第一段：`/settings/general?x=1` → `/settings`。 */
function rootOf(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] || "/"
  const first = bare.split("/").filter(Boolean)[0]
  return first ? `/${first}` : "/"
}

function readOpenedRoots(): string[] {
  const raw = readStored(OPENED_IN_PAGE_KEY)
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((r): r is string => typeof r === "string")
      : []
  } catch {
    return []
  }
}

function writeOpenedRoots(roots: string[]): void {
  writeStored(OPENED_IN_PAGE_KEY, roots.length ? JSON.stringify(roots) : null)
}

/** 现在这一页是不是在当前页里打开的（由 {@link navigateInPage} 打开）。 */
export function wasOpenedInPage(): boolean {
  if (typeof window === "undefined") return false
  return readOpenedRoots().includes(rootOf(window.location.pathname))
}

/** 在当前页里打开 `path`（Next 路由跳转；还没注册路由时整页跳过去）。 */
export function navigateInPage(path: string): void {
  const root = rootOf(path)
  if (root === IN_PAGE_HOME_PATH) {
    writeOpenedRoots([])
  } else {
    const roots = readOpenedRoots()
    if (!roots.includes(root)) writeOpenedRoots([...roots, root])
  }
  if (inPageRouter) {
    inPageRouter.push(path)
    return
  }
  window.location.assign(path)
}

/** 离开当前页：有历史记录就后退，没有就回到工作区。 */
export function leaveInPage(): void {
  if (window.history.length > 1) {
    if (inPageRouter) inPageRouter.back()
    else window.history.back()
    return
  }
  navigateInPage(IN_PAGE_HOME_PATH)
}

/**
 * 网页版另开窗口（`window.open`）时包一层：新窗口会复制这个标签页的
 * sessionStorage，复制那一下先把「在当前页打开」的记录拿掉、开完再放回去，
 * 免得新窗口把自己当成在当前页打开的、做完不关窗口。只在 sessionStorage 里
 * 动，内存里的照旧。
 */
export function withoutInPageRecord<T>(fn: () => T): T {
  let saved: string | null = null
  try {
    saved = window.sessionStorage.getItem(OPENED_IN_PAGE_KEY)
    if (saved !== null) window.sessionStorage.removeItem(OPENED_IN_PAGE_KEY)
  } catch {
    saved = null
  }
  try {
    return fn()
  } finally {
    if (saved !== null) {
      try {
        window.sessionStorage.setItem(OPENED_IN_PAGE_KEY, saved)
      } catch {
        // 内存里还有
      }
    }
  }
}

/**
 * 网页版的设置、提交这类页面要「关掉自己」时：这一页是在当前页里打开的，
 * 就返回上一页并返回 true；否则返回 false，调用方照旧关窗口。
 *
 * 先看 {@link wasOpenedInPage}（不管现在多宽、有没有 opener）。没有记录
 * （sessionStorage 被清掉这类少见情况）才退回去猜：手机布局、而且不是脚本另开的窗口
 * （没有 opener），就当成在当前页里。
 */
export function leaveIfOpenedInPage(): boolean {
  if (!wasOpenedInPage()) {
    if (!isMobileLayout()) return false
    if (window.opener) return false
  }
  leaveInPage()
  return true
}

/**
 * 新建项目页在当前页里打开时，建好项目那一刻工作区没挂着，后端广播的
 * 「在工作区打开这个文件夹」没人收。先把文件夹记下来，工作区回来挂上
 * 监听时取走，照收到广播那样打开（#1332）。和上面的记录一样放在
 * sessionStorage 里：新建项目页上刷新过、回到工作区是整页载入，都还在。
 */
export function setPendingWorkspaceFolder(detail: FolderDetail): void {
  writeStored(PENDING_FOLDER_KEY, JSON.stringify(detail))
}

/** 取走待打开的文件夹（取一次就清空）。 */
export function takePendingWorkspaceFolder(): FolderDetail | null {
  const raw = readStored(PENDING_FOLDER_KEY)
  if (raw === null) return null
  writeStored(PENDING_FOLDER_KEY, null)
  try {
    return JSON.parse(raw) as FolderDetail
  } catch {
    return null
  }
}
