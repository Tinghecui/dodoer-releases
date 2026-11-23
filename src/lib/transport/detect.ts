export type TransportEnvironment = "tauri" | "web"

declare global {
  interface Window {
    /// iOS 壳在每个页面脚本运行前注入的标记，值为 "ios"（#1332）。
    __CODEG_SHELL__?: string
  }
}

/// 是不是跑在 iOS 壳里。壳只带启动页，之后加载的是服务器自己的网页界面，
/// 所以在壳里即使有 Tauri 的注入对象，也要按网页版运行。
export function isIosShell(): boolean {
  return typeof window !== "undefined" && window.__CODEG_SHELL__ === "ios"
}

export function detectEnvironment(): TransportEnvironment {
  if (isIosShell()) return "web"
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return "tauri"
  }
  return "web"
}
