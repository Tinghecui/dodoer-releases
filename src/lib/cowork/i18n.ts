// Strings for the Cowork-only UI. Kept out of the upstream message catalogs on
// purpose: those are type-checked against en.json and must keep key parity
// across all ten locales, and every upstream release rewrites them. Locales
// without an entry here fall back to English.

import { useCallback } from "react"
import { useLocale } from "next-intl"

const en = {
  account: "Account",
  statusItems: "Commands and status",
  myAccount: "My account",
  openInDesktop: "Open in desktop app",
  openInDesktopFailed: "Couldn't open the desktop app: {message}",
  signOut: "Sign out / switch account",
  newProject: "New project",
  newProjectHint: "Creates a folder under {root}",
  projectNamePlaceholder: "Project name",
  create: "Create",
  orOpenExisting: "Or open an existing folder",
  nameEmpty: "Enter a project name",
  nameInvalid: "A project name can't contain / or \\, or start with .",
  createFailed: "Couldn't create the project",
  portalSignIn: "Sign in through the Cowork portal",
  upgradeAvailable: "Cowork {version} is available — upgrade in the portal",
  desktopTooOld: "This desktop app is too old for the server",
  desktopTooOldHint:
    "The server needs dodoer {required} or newer; this is {version}. Update the app.",
  serverTooOld: "The server is too old for this desktop app",
  serverTooOldHint:
    "Ask an administrator to upgrade Cowork in the portal. Some features may not work until then.",
  checkForUpdate: "Check for update",
}

export type CoworkTextKey = keyof typeof en

const zhCN: Record<CoworkTextKey, string> = {
  account: "账户",
  statusItems: "命令和状态",
  myAccount: "我的账户",
  openInDesktop: "在桌面 app 里打开",
  openInDesktopFailed: "没能打开桌面 app：{message}",
  signOut: "退出 / 切换账户",
  newProject: "新建项目",
  newProjectHint: "在 {root} 下创建文件夹",
  projectNamePlaceholder: "项目名称",
  create: "创建",
  orOpenExisting: "或打开已有文件夹",
  nameEmpty: "请输入项目名称",
  nameInvalid: "项目名称不能包含 / 或 \\，也不能以 . 开头",
  createFailed: "创建项目失败",
  portalSignIn: "通过 Cowork 门户登录",
  upgradeAvailable: "Cowork {version} 可以升级，去门户升级",
  desktopTooOld: "桌面 app 版本太旧，和服务器不匹配",
  desktopTooOldHint:
    "服务器需要 dodoer {required} 或更新的版本，当前是 {version}。请更新 app。",
  serverTooOld: "服务器版本太旧，和这个桌面 app 不匹配",
  serverTooOldHint: "请管理员在门户里升级 Cowork。升级之前有些功能可能用不了。",
  checkForUpdate: "检查更新",
}

const zhTW: Record<CoworkTextKey, string> = {
  account: "帳戶",
  statusItems: "命令和狀態",
  myAccount: "我的帳戶",
  openInDesktop: "在桌面 app 中開啟",
  openInDesktopFailed: "無法開啟桌面 app：{message}",
  signOut: "登出 / 切換帳戶",
  newProject: "新增專案",
  newProjectHint: "在 {root} 下建立資料夾",
  projectNamePlaceholder: "專案名稱",
  create: "建立",
  orOpenExisting: "或開啟現有資料夾",
  nameEmpty: "請輸入專案名稱",
  nameInvalid: "專案名稱不能包含 / 或 \\，也不能以 . 開頭",
  createFailed: "建立專案失敗",
  portalSignIn: "透過 Cowork 入口網站登入",
  upgradeAvailable: "Cowork {version} 可以升級，到入口網站升級",
  desktopTooOld: "桌面 app 版本太舊，和伺服器不相容",
  desktopTooOldHint:
    "伺服器需要 dodoer {required} 或更新的版本，目前是 {version}。請更新 app。",
  serverTooOld: "伺服器版本太舊，和這個桌面 app 不相容",
  serverTooOldHint:
    "請管理員在入口網站升級 Cowork。升級之前有些功能可能無法使用。",
  checkForUpdate: "檢查更新",
}

const CATALOGS: Record<string, Record<CoworkTextKey, string>> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
}

export function coworkText(
  locale: string,
  key: CoworkTextKey,
  values?: Record<string, string>
): string {
  const template = (CATALOGS[locale] ?? en)[key] ?? en[key]
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? values[name] : match
  )
}

export function useCoworkText() {
  const locale = useLocale()
  return useCallback(
    (key: CoworkTextKey, values?: Record<string, string>) =>
      coworkText(locale, key, values),
    [locale]
  )
}
