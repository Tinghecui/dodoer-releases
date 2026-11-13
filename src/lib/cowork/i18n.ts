// Strings for the Cowork-only UI. Kept out of the upstream message catalogs on
// purpose: those are type-checked against en.json and must keep key parity
// across all ten locales, and every upstream release rewrites them. Locales
// without an entry here fall back to English.

import { useCallback } from "react"
import { useLocale } from "next-intl"

const en = {
  account: "Account",
  statusItems: "Status",
  runCommand: "Run a command",
  statusAlerts: "{count} alerts",
  statusUpdate: "update available",
  statusBusy: "working",
  notServedHere: "Not on this server — only in a workspace on your computer.",
  // A settings page the nav hides here, opened by its address
  // (`settings-page-unavailable.tsx`).
  settingsPageUnavailable: "This settings page isn't available here.",
  settingsPageManaged: "This server is managed by your administrator.",
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
  // `next` is the label of the dialog's button that opens the selected folder.
  projectExists:
    'There is already a project named {name}. Pick another name; to open the existing one, select it in the list below and click "{next}".',
  portalSignIn: "Sign in through the Cowork portal",
  upgradeAvailable: "Cowork {version} is available — upgrade in the portal",
  desktopTooOld: "This desktop app is too old for the server",
  desktopTooOldHint:
    "The server needs dodoer {required} or newer; this is {version}. Update the app.",
  serverTooOld: "The server is too old for this desktop app",
  serverTooOldHint:
    "Ask an administrator to upgrade Cowork in the portal. Some features may not work until then.",
  checkForUpdate: "Check for update",
  // The main window's start page (`start-home.tsx`).
  startTitle: "Where do you want to work?",
  startIntro:
    "Work on this computer, or on a server — each server opens in its own window, and the local workspace can stay open next to them.",
  startLocalTitle: "Work on this computer",
  startLocalHint:
    "Folders, conversations and agents on this computer, run by {product} itself.",
  startLocalOpen: "Open local workspace",
  startSaved: "Servers",
  startEmpty: "No server added yet.",
  startOpen: "Open",
  startManage: "Add or manage servers",
  startPortalHint:
    'With Cowork: in the portal, open My account → Desktop → "Open in desktop app". This app asks once, then connects.',
  startNoLocal:
    "This app was started without a local daemon (CODEG_DESKTOP_DAEMON=client), so only servers can be opened.",
  // Quick actions in the local workspace: back to the start page.
  backToStart: "Back to start page",
  // The resource meter (`resource-meter.tsx`).
  resources: "System resources",
  resourcesThisComputer: "This computer",
  resourcesServer: "Server",
  resourcesSummary: "CPU {cpu} · Memory {memory}",
  resourcesCpu: "CPU",
  resourcesCores: "{count} cores",
  resourcesLoad: "{count} cores · load {load}",
  resourcesMemory: "Memory",
  resourcesAvailable: "{value} available",
  resourcesSwap: "Swap",
  resourcesDisk: "Disk",
  resourcesFree: "{value} free",
  resourcesWorkspace: "This workspace",
  resourcesWorkspaceHint: "Its own processes: agents, terminals, builds",
  resourcesLimit: "Memory limit",
  resourcesPressureNormal: "Normal",
  resourcesPressureWarning: "Tight",
  resourcesPressureCritical: "Almost full",
  resourcesWarningHint:
    "Memory is getting tight. A big job (a build, a full test run) may not fit.",
  resourcesCriticalHint:
    "Memory is almost full, and the system may start killing processes. Stop what you don't need before starting anything big.",
  resourcesCriticalTitle: "Memory is almost full",
  resourcesCriticalDetail: "{where}: {available} left of {total}.",
  // A request that got no response at all (`toErrorMessage`, #71).
  networkUnreachable:
    "Can't reach the server. Check your network connection; it reconnects on its own once the network is back.",
  // First steps on an empty workspace (`getting-started-card.tsx`), and the
  // sidebar's button for the same first step.
  newOrOpenProject: "New or open project",
  gettingStartedTitle: "Get started",
  gettingStartedProject: "Create or open a project",
  gettingStartedProjectHint:
    "Give it a name and it is created under {root}, or open a folder that is already there.",
  gettingStartedProjectHintOpen:
    "A project is a folder: open the one you want to work in.",
  gettingStartedAgent: "Pick an agent",
  gettingStartedAgentHint:
    "Start a new conversation in the project and choose an agent in the list above the message box.",
  gettingStartedMessage: "Send your first message",
  gettingStartedMessageHint:
    "Write what you want done and press {key} to send it.",
  // Behind the portal, "Sign in" for an agent whose credentials the portal
  // manages opens its AI accounts (`sign-in.ts`, #158).
  signInViaPortal: "Set up AI accounts in the portal",
  turnFailedAuthRequiredPortal:
    "{agent} needs you to sign in again before it can run this turn. Set it up in the portal under My account → AI accounts, then send this message again.",
  // A queued message read back after a reload (#159): marked failed, never
  // sent on its own.
  queueRestoredReason:
    "It had not been sent when the page reloaded, and is not sent again on its own so it cannot go out twice.",
}

export type CoworkTextKey = keyof typeof en

const zhCN: Record<CoworkTextKey, string> = {
  account: "账户",
  statusItems: "状态",
  runCommand: "运行命令",
  statusAlerts: "{count} 条提醒",
  statusUpdate: "有新版本",
  statusBusy: "后台任务进行中",
  notServedHere: "这台服务器上不可用，只能在本机工作区里用。",
  settingsPageUnavailable: "这个设置页在这里不可用。",
  settingsPageManaged: "这台服务器由管理员管理。",
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
  projectExists:
    "已经有一个叫 {name} 的项目了，换个名称；要打开已有的项目，在下面的列表里选中它，再点「{next}」。",
  portalSignIn: "通过 Cowork 门户登录",
  upgradeAvailable: "Cowork {version} 可以升级，去门户升级",
  desktopTooOld: "桌面 app 版本太旧，和服务器不匹配",
  desktopTooOldHint:
    "服务器需要 dodoer {required} 或更新的版本，当前是 {version}。请更新 app。",
  serverTooOld: "服务器版本太旧，和这个桌面 app 不匹配",
  serverTooOldHint: "请管理员在门户里升级 Cowork。升级之前有些功能可能用不了。",
  checkForUpdate: "检查更新",
  startTitle: "在哪里工作？",
  startIntro:
    "在这台电脑上，或者在服务器上。每台服务器在自己的窗口里打开，本机工作区可以和它们同时开着。",
  startLocalTitle: "在这台电脑上工作",
  startLocalHint: "这台电脑上的文件夹、对话和 agent，由 {product} 自己运行。",
  startLocalOpen: "打开本机工作区",
  startSaved: "服务器",
  startEmpty: "还没有添加服务器。",
  startOpen: "打开",
  startManage: "添加或管理服务器",
  startPortalHint:
    "用 Cowork：在门户「我的账户」的「桌面版」里点「在桌面 app 里打开」，这个 app 会问一句，然后自动连上。",
  startNoLocal:
    "这次启动没有本机 daemon（CODEG_DESKTOP_DAEMON=client），只能打开服务器。",
  backToStart: "回到开始页",
  resources: "资源占用",
  resourcesThisComputer: "这台电脑",
  resourcesServer: "服务器",
  resourcesSummary: "CPU {cpu} · 内存 {memory}",
  resourcesCpu: "CPU",
  resourcesCores: "{count} 核",
  resourcesLoad: "{count} 核 · 负载 {load}",
  resourcesMemory: "内存",
  resourcesAvailable: "可用 {value}",
  resourcesSwap: "交换区",
  resourcesDisk: "磁盘",
  resourcesFree: "剩余 {value}",
  resourcesWorkspace: "本工作区",
  resourcesWorkspaceHint: "它自己的进程：agent、终端、编译",
  resourcesLimit: "内存上限",
  resourcesPressureNormal: "正常",
  resourcesPressureWarning: "偏紧",
  resourcesPressureCritical: "快满了",
  resourcesWarningHint: "内存偏紧。再起大任务（编译、全量测试）可能放不下。",
  resourcesCriticalHint:
    "内存快用完了，系统可能开始杀进程。先停掉不用的任务，再起大任务。",
  resourcesCriticalTitle: "内存快用完了",
  resourcesCriticalDetail: "{where}只剩 {available}（共 {total}）。",
  networkUnreachable: "连不上服务器，请检查网络。网络恢复后会自动重连。",
  newOrOpenProject: "新建或打开项目",
  gettingStartedTitle: "从这里开始",
  gettingStartedProject: "新建或打开一个项目",
  gettingStartedProjectHint:
    "起个名字，就在 {root} 下建好；也可以打开那里已有的文件夹。",
  gettingStartedProjectHintOpen: "一个项目就是一个文件夹，打开你要干活的那个。",
  gettingStartedAgent: "选一个 agent",
  gettingStartedAgentHint:
    "在项目里开一个新对话，从输入框上方的列表里选一个 agent。",
  gettingStartedMessage: "发出第一条消息",
  gettingStartedMessageHint: "写下要它做的事，按 {key} 发送。",
  signInViaPortal: "去门户配置 AI 账户",
  turnFailedAuthRequiredPortal:
    "{agent} 需要你重新登录后才能执行本轮回复。请到门户「我的账户 → AI 账户」配置，然后重新发送这条消息。",
  queueRestoredReason: "页面刷新时还没发出去，为免重复发送，不会自动续发。",
}

const zhTW: Record<CoworkTextKey, string> = {
  account: "帳戶",
  statusItems: "狀態",
  runCommand: "執行命令",
  statusAlerts: "{count} 則提醒",
  statusUpdate: "有新版本",
  statusBusy: "背景工作進行中",
  notServedHere: "這台伺服器上不可用，只能在本機工作區裡用。",
  settingsPageUnavailable: "這個設定頁在這裡無法使用。",
  settingsPageManaged: "這台伺服器由管理員管理。",
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
  projectExists:
    "已經有一個叫 {name} 的專案了，換個名稱；要開啟現有的專案，在下面的清單裡選取它，再按「{next}」。",
  portalSignIn: "透過 Cowork 入口網站登入",
  upgradeAvailable: "Cowork {version} 可以升級，到入口網站升級",
  desktopTooOld: "桌面 app 版本太舊，和伺服器不相容",
  desktopTooOldHint:
    "伺服器需要 dodoer {required} 或更新的版本，目前是 {version}。請更新 app。",
  serverTooOld: "伺服器版本太舊，和這個桌面 app 不相容",
  serverTooOldHint:
    "請管理員在入口網站升級 Cowork。升級之前有些功能可能無法使用。",
  checkForUpdate: "檢查更新",
  startTitle: "在哪裡工作？",
  startIntro:
    "在這台電腦上，或者在伺服器上。每台伺服器在自己的視窗裡開啟，本機工作區可以和它們同時開著。",
  startLocalTitle: "在這台電腦上工作",
  startLocalHint: "這台電腦上的資料夾、對話和 agent，由 {product} 自己執行。",
  startLocalOpen: "開啟本機工作區",
  startSaved: "伺服器",
  startEmpty: "還沒有新增伺服器。",
  startOpen: "開啟",
  startManage: "新增或管理伺服器",
  startPortalHint:
    "用 Cowork：在入口網站「我的帳戶」的「桌面版」裡點「在桌面 app 中開啟」，這個 app 會問一句，然後自動連上。",
  startNoLocal:
    "這次啟動沒有本機 daemon（CODEG_DESKTOP_DAEMON=client），只能開啟伺服器。",
  backToStart: "回到開始頁",
  resources: "資源用量",
  resourcesThisComputer: "這台電腦",
  resourcesServer: "伺服器",
  resourcesSummary: "CPU {cpu} · 記憶體 {memory}",
  resourcesCpu: "CPU",
  resourcesCores: "{count} 核心",
  resourcesLoad: "{count} 核心 · 負載 {load}",
  resourcesMemory: "記憶體",
  resourcesAvailable: "可用 {value}",
  resourcesSwap: "交換空間",
  resourcesDisk: "磁碟",
  resourcesFree: "剩餘 {value}",
  resourcesWorkspace: "本工作區",
  resourcesWorkspaceHint: "它自己的行程：agent、終端機、編譯",
  resourcesLimit: "記憶體上限",
  resourcesPressureNormal: "正常",
  resourcesPressureWarning: "偏緊",
  resourcesPressureCritical: "快滿了",
  resourcesWarningHint:
    "記憶體偏緊。再啟動大型工作（編譯、完整測試）可能放不下。",
  resourcesCriticalHint:
    "記憶體快用完了，系統可能開始終止行程。先停掉不用的工作，再啟動大型工作。",
  resourcesCriticalTitle: "記憶體快用完了",
  resourcesCriticalDetail: "{where}只剩 {available}（共 {total}）。",
  networkUnreachable: "連不上伺服器，請檢查網路。網路恢復後會自動重新連線。",
  newOrOpenProject: "新增或開啟專案",
  gettingStartedTitle: "從這裡開始",
  gettingStartedProject: "新增或開啟一個專案",
  gettingStartedProjectHint:
    "取個名字，就在 {root} 下建立；也可以開啟那裡現有的資料夾。",
  gettingStartedProjectHintOpen: "一個專案就是一個資料夾，開啟你要工作的那個。",
  gettingStartedAgent: "選一個 agent",
  gettingStartedAgentHint:
    "在專案裡開一個新對話，從輸入框上方的清單裡選一個 agent。",
  gettingStartedMessage: "送出第一則訊息",
  gettingStartedMessageHint: "寫下要它做的事，按 {key} 送出。",
  signInViaPortal: "到入口網站設定 AI 帳戶",
  turnFailedAuthRequiredPortal:
    "{agent} 需要你重新登入後才能執行本輪回覆。請到入口網站「我的帳戶 → AI 帳戶」設定，然後重新傳送這則訊息。",
  queueRestoredReason: "頁面重新整理時還沒送出，為避免重複傳送，不會自動續傳。",
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
