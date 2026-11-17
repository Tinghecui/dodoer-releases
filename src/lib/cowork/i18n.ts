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
  // The portal throttled us: too many requests in a short time (#336).
  rateLimited: "Too many requests. Retrying automatically in a moment.",
  // The agent list has not come back yet (or failed once and is retrying), so
  // "no enabled agents" would be a guess (`agent-selector.tsx`, #336).
  agentListLoading: "Loading agents…",
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
  // A sent message whose turn failed before the agent answered (#424).
  queueTurnFailedReason:
    "This message was sent, but the turn failed partway. Retrying sends it again.",
  // Lending this computer's shell to a remote workspace
  // (`status-bar-host-ssh.tsx`, `docs/host-ssh.md`).
  hostSshTitle: "Lend this computer to agents",
  hostSshTooltipOn: "This computer is lent to this workspace's agents",
  hostSshTooltipOff: "This computer is not lent to this workspace",
  hostSshLent: "Lent",
  hostSshNotLent: "Not lent",
  hostSshHintOff:
    "Once lent, the agents of {server} can run any command on this computer as you, and read and change your files. Lend it only to a server you trust.",
  hostSshHintOn:
    "The agents of {server} can run commands on this computer as you (they use `ssh` and this computer's name in the devices list), while this window is open.",
  hostSshAwake:
    "While lent, this computer does not go to sleep (when on power).",
  hostSshStopped:
    "Lending to {server} was stopped from another device: the command line, the browser and Chrome are not lent to it. Only this computer can lend them again.",
  hostSshLendAgainHint:
    "“Lend again” gives back the browser and Chrome as their own switches say; the command line takes “Lend this computer” below.",
  hostSshLendAgain: "Lend again",
  hostSshStoppedToast: "Lending to {server} was stopped from another device.",
  hostSshTooltipStopped: "Lending was stopped from another device",
  hostSshServerNotReady:
    "This server cannot reach a lent computer yet — it needs a newer Cowork. For now lending only readies this computer, and the self-test is all that logs in.",
  hostSshNotRunning: "The SSH service did not start: {detail}",
  hostSshLend: "Lend this computer",
  hostSshStop: "Stop lending",
  hostSshWorking: "Working…",
  hostSshSelfTest: "Self-test",
  hostSshTesting: "Testing…",
  hostSshSelfTestOk:
    "Self-test passed: it logged in and ran a command. Tools it finds: {tools}",
  hostSshSelfTestNoTools: "none",
  hostSshSelfTestFailed: "Self-test failed: {detail}",
  hostSshConfirmTitle: "Lend this computer to {server}?",
  hostSshConfirmBody:
    "Its agents will be able to run any command here as you: read, change and delete your files, start apps, and use the accounts you are signed in to. It cannot be limited to a folder. You can stop lending from this icon at any time.",
  hostSshConfirm: "Lend",
  hostSshCancel: "Cancel",
  hostSshPermissions: "macOS permissions",
  hostSshPermScreenRecording: "Screen Recording",
  hostSshPermAccessibility: "Accessibility",
  hostSshPermGranted: "Granted",
  hostSshPermMissing: "Not granted or stale",
  hostSshPermFix: "Fix",
  hostSshPermHint:
    "Commands agents run over SSH use dodoer's permissions. After dodoer updates, the switch in System Settings can stay on while the grant no longer works. Fix clears the old grant and brings up the system's request: allow dodoer there, and macOS asks to reopen it. Granted, these permissions also reach the agents of workspaces on this computer.",
  hostSshPermNotSelf:
    "dodoer was started from another app (a terminal?), so these are that app's permissions and can't be fixed here. Open dodoer from Applications to see its own.",
  hostSshPermAsked:
    "Asked. Turn dodoer on in System Settings, then reopen dodoer when macOS asks; the status updates after that.",
  hostSshPermFixFailed: "Couldn't fix: {detail}",
  // "Report a problem" in the account menu (`feedback-dialog.tsx`).
  feedback: "Report a problem",
  feedbackHint:
    "Say what happened. Sent with it: the number of the conversation that is open, the versions and the state of the connection — never what the conversation says. Paths and tokens are taken out of your text.",
  feedbackPlaceholder:
    "For example: after I sent a message it kept showing it as in progress",
  feedbackSend: "Send",
  feedbackCancel: "Cancel",
  feedbackSent: "Sent. Thank you!",
  feedbackNotSent: "Not sent: this server does not collect diagnostics.",
  // The person's devices (`status-bar-devices.tsx`, `docs/devices.md`).
  devicesTitle: "Devices",
  devicesIntro:
    "Every computer that connected dodoer to this workspace, under the name you and the agents call it by.",
  devicesEmpty: "No computer has connected yet.",
  devicesThis: "This computer",
  devicesOnline: "Online",
  devicesLastSeen: "Last online {when}",
  devicesLendsShell: "Command line",
  devicesLendsBrowser: "Browser",
  devicesLendsChrome: "Chrome",
  devicesLendsNothing: "Lends nothing",
  devicesRename: "Rename",
  devicesSave: "Save",
  devicesCancel: "Cancel",
  devicesForget: "Remove",
  devicesForgetConfirm: "Remove {name} from the list?",
  devicesNameLabel: "Name",
  devicesNameRule:
    "Use lowercase letters, digits and dashes, starting and ending with a letter or a digit, at most 32.",
  devicesNameTaken: "Another device is called {name} already.",
  devicesFailed: "Could not change it: {message}",
  devicesUnnamedHosts:
    "{count} older dodoer connected as well. Update it there to see it in this list.",
  devicesNameTitle: "Name this computer",
  devicesNameBody:
    "You and the agents will call this computer by this name. You can change it later from the devices icon at the foot of the sidebar.",
  devicesNameConfirm: "Use this name",
  devicesNameSkip: "Skip",
  devicesStop: "Stop lending",
  devicesStopConfirm:
    "Stop everything {name} lends? What agents are running there is cut off, and only that computer can lend it again.",
  devicesStopped:
    "Lending stopped from elsewhere. Lend it again on that computer (an older dodoer there needs updating first).",
  devicesInUse: "In use by: {titles}",
  devicesUntitled: "Untitled",
  // The mark beside a conversation's composer (`conversation-device-badge.tsx`).
  conversationDeviceWorksOn:
    "The agent of this conversation works on {name}. To switch, tell it which device to use.",
  conversationDeviceOffline:
    "{name} is offline (last online {when}). Open this workspace in dodoer on it for the agent to go on.",
  conversationDeviceLendsNothing:
    "{name} lends neither its command line nor its browser now. Turn lending on there for the agent to go on.",
  // The button's menu: the person picks the conversation's computer
  // (`docs/devices.md` 6.7).
  conversationDeviceWorksOnPick:
    "The agent of this conversation works on {name}. Click to pick another computer.",
  conversationDevicePick: "Pick a computer",
  conversationDevicePickHint:
    "Pick which of your computers the agent of this conversation uses.",
  conversationDeviceNeedsPick:
    "The agent is waiting for you to pick a computer for this conversation.",
  conversationDevicePickTitle: "Computer for this conversation",
  conversationDevicePickIntro:
    "The agent runs commands and opens pages on the one you pick, and only there, until you pick another here or ask it to switch.",
  conversationDevicePickNone: "Use no computer",
  conversationDevicePickLoading: "Loading…",
  conversationDevicePickFailed: "Could not pick it: {message}",
  // 命令行和浏览器分开选（服务器有 `conversation_device_split` 时）。
  conversationDeviceSplitIntro:
    "The command line and the browser can be on different computers.",
  conversationDeviceNotPicked: "Not picked",
  conversationDeviceNotLent: "Not lent",
  conversationDeviceOfflineShort: "Offline",
  conversationDeviceStoppedShort: "Stopped",
  conversationDeviceBuiltInBrowser: "Built-in browser",
  conversationDevicePartOn: "{part} on {name}",
  conversationDevicePartIs: "{part}: {name}",
  conversationDevicePartInUse: "{part}: {name}, in use by the agent now",
  conversationDevicePartNotPicked: "{part}: no computer picked",
  conversationDeviceShellWaiting:
    "The agent is waiting for you to pick a computer for the command line.",
  conversationDeviceBrowserWaiting:
    "The agent is waiting for you to pick a computer for the browser.",
  conversationDeviceShellNotLent:
    "{name} does not lend its command line now. Turn lending on there for the agent to go on.",
  conversationDeviceBrowserNotLent:
    "{name} does not lend its browser now. Turn lending on there for the agent to go on.",
  conversationDevicePartOffline:
    "{part}: {name} is offline (last online {when}). Open this workspace in dodoer on it for the agent to go on.",
  conversationDevicePartStopped:
    "{part}: lending on {name} was stopped from elsewhere. Lend it again on that computer for the agent to go on.",
  conversationDeviceSplitPickHint:
    "Click to pick computers for the command line and the browser.",
  // The mark on a conversation's row and tab while its agent uses one of
  // the person's computers (`session-usage-mark.tsx`).
  usageChromeOn: "Using Chrome on {name}",
  usageChromeHere: "Using the Chrome on your computer",
  usageBrowserOn: "Using the browser on {name}",
  usageBrowserHere: "Using the browser on your computer",
  usageShellOn:
    "Using the command line of {name} (an idle connection stays open up to 10 minutes)",
  usageShellHere:
    "Using the command line of your computer (an idle connection stays open up to 10 minutes)",
  // A model switch (`model-switch.ts`): the composer's picker while it is
  // under way, then a line in the conversation and, if it failed, a toast.
  modelSwitchPending: "Switching to {to}…",
  modelSwitchAfterTurn: "This reply {from} · next {to}",
  modelSwitchAfterTurnHint:
    "This reply keeps using {from}; {to} takes over from your next message.",
  modelSwitchApplied: "Model switched: {from} → {to} (from the next message)",
  modelSwitchFailed: "Couldn't switch to {to}: {reason}. Still using {current}",
  modelSwitchNoAnswer: "the agent didn't answer within 10 seconds",
  modelSwitchAgentError: "the agent reported an error ({detail})",
  modelSwitchNotAdopted: "the agent didn't take it",
  // The picker's mark on the row of the model a switch under way goes to.
  modelSwitchNextMark: "From next message",
  modelSwitchPendingMark: "Switching",
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
  rateLimited: "请求太频繁，稍后自动重试。",
  agentListLoading: "正在加载 Agent 列表…",
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
  queueTurnFailedReason: "这条已经发出，本轮中途失败；重试会再发一次。",
  hostSshTitle: "把这台电脑借给智能体",
  hostSshTooltipOn: "这台电脑已借给这个工作区的智能体",
  hostSshTooltipOff: "这台电脑没有借给这个工作区",
  hostSshLent: "已借出",
  hostSshNotLent: "未借出",
  hostSshHintOff:
    "借出后，「{server}」的智能体能以你的身份在这台电脑上执行任何命令、读写你的文件。只借给你信任的服务器。",
  hostSshHintOn:
    "「{server}」的智能体可以以你的身份在这台电脑上执行命令（它们用 `ssh` 加这台电脑在设备列表里的名字），只在这个窗口开着时有效。",
  hostSshAwake: "借出期间这台电脑不会睡眠（接着电源时）。",
  hostSshStopped:
    "已从别的设备停止借出：命令行、浏览器和 Chrome 都不再借给「{server}」，只能在这台电脑上重新借出。",
  hostSshLendAgainHint:
    "「重新借出」按浏览器和 Chrome 各自的开关恢复；命令行要再点下面的「借出这台电脑」。",
  hostSshLendAgain: "重新借出",
  hostSshStoppedToast: "已从别的设备停止借给「{server}」。",
  hostSshTooltipStopped: "已从别的设备停止借出",
  hostSshServerNotReady:
    "这台服务器现在还连不到借出的电脑，要等 Cowork 升级。目前借出只是把这台电脑这一侧准备好，只有自检会登录进来。",
  hostSshNotRunning: "SSH 服务没有启动：{detail}",
  hostSshLend: "借出这台电脑",
  hostSshStop: "停止借出",
  hostSshWorking: "处理中…",
  hostSshSelfTest: "自检",
  hostSshTesting: "自检中…",
  hostSshSelfTestOk: "自检通过：能登录、能执行命令。找得到的工具：{tools}",
  hostSshSelfTestNoTools: "没有",
  hostSshSelfTestFailed: "自检没通过：{detail}",
  hostSshConfirmTitle: "把这台电脑借给「{server}」？",
  hostSshConfirmBody:
    "它的智能体将能以你的身份在这台电脑上执行任何命令：读、改、删你的文件，启动软件，使用你已登录的账号。没法只限定某个文件夹。随时可以点这个图标停止借出。",
  hostSshConfirm: "借出",
  hostSshCancel: "取消",
  hostSshPermissions: "macOS 权限",
  hostSshPermScreenRecording: "屏幕录制",
  hostSshPermAccessibility: "辅助功能",
  hostSshPermGranted: "已授权",
  hostSshPermMissing: "未授权或已失效",
  hostSshPermFix: "修复",
  hostSshPermHint:
    "智能体经 SSH 执行的命令，用的是 dodoer 的权限。dodoer 更新后，系统设置里的开关可能还亮着，实际已经失效。点「修复」会清掉旧授权，并弹出系统的授权框：在那里允许 dodoer，macOS 会要求重开 dodoer。注意：授权后，这台电脑上本机工作区的智能体也能用这些权限。",
  hostSshPermNotSelf:
    "dodoer 是从别的程序（比如终端）里启动的，这里显示的是那个程序的权限，在这里修复不了。从「应用程序」打开 dodoer 再看。",
  hostSshPermAsked:
    "已发出授权请求。在系统设置里打开 dodoer 的开关，按提示重开 dodoer，之后这里会更新。",
  hostSshPermFixFailed: "修复失败：{detail}",
  feedback: "反馈问题",
  feedbackHint:
    "写下遇到了什么。会一起发出：当前打开的对话的编号、版本号、连接状态；不会带上对话内容。你写的文字里的路径和令牌会被去掉。",
  feedbackPlaceholder: "比如：发出消息后一直显示进行中",
  feedbackSend: "发送",
  feedbackCancel: "取消",
  feedbackSent: "已发送，谢谢！",
  feedbackNotSent: "没发出去：这台服务器没有开诊断数据上报。",
  devicesTitle: "设备",
  devicesIntro: "连过这个工作区的电脑都在这里。名字是你和智能体称呼它的方式。",
  devicesEmpty: "还没有电脑连过。",
  devicesThis: "这台",
  devicesOnline: "在线",
  devicesLastSeen: "上次在线：{when}",
  devicesLendsShell: "命令行",
  devicesLendsBrowser: "浏览器",
  devicesLendsChrome: "Chrome",
  devicesLendsNothing: "没有借出",
  devicesRename: "改名",
  devicesSave: "保存",
  devicesCancel: "取消",
  devicesForget: "删除",
  devicesForgetConfirm: "从列表里删除 {name}？",
  devicesNameLabel: "名字",
  devicesNameRule:
    "只能用小写字母、数字和短横线，开头和结尾是字母或数字，最多 32 个字符。",
  devicesNameTaken: "已经有设备叫 {name}。",
  devicesFailed: "没改成：{message}",
  devicesUnnamedHosts:
    "还有 {count} 个旧版 dodoer 连着，那台更新后才会出现在这里。",
  devicesNameTitle: "给这台电脑起个名字",
  devicesNameBody:
    "你和智能体会用这个名字称呼这台电脑。以后可以在侧栏底部的设备图标里改。",
  devicesNameConfirm: "就用这个",
  devicesNameSkip: "跳过",
  devicesStop: "停止借出",
  devicesStopConfirm:
    "停止 {name} 的所有借出？智能体在那台电脑上正在跑的会断开，之后只能在那台电脑上重新借出。",
  devicesStopped:
    "已从别处停止借出。要在那台电脑上重新借出（那台的 dodoer 是老版本的话要先更新）。",
  devicesInUse: "正在用它的对话：{titles}",
  devicesUntitled: "未命名",
  conversationDeviceWorksOn:
    "这个对话的智能体在 {name} 上操作。要换，跟它说用哪台。",
  conversationDeviceOffline:
    "{name} 不在线（上次在线：{when}）。在那台电脑的 dodoer 里打开这个工作区，智能体才能接着用。",
  conversationDeviceLendsNothing:
    "{name} 现在命令行和浏览器都没借出。在那台电脑上打开借出，智能体才能接着用。",
  conversationDeviceWorksOnPick:
    "这个对话的智能体在 {name} 上操作。点一下换一台电脑。",
  conversationDevicePick: "选电脑",
  conversationDevicePickHint: "选这个对话的智能体用你的哪台电脑。",
  conversationDeviceNeedsPick: "智能体在等你给这个对话选一台电脑。",
  conversationDevicePickTitle: "这个对话用的电脑",
  conversationDevicePickIntro:
    "智能体只在你选的这台上跑命令、开网页，直到你在这里换一台，或者在对话里让它换。",
  conversationDevicePickNone: "不用电脑",
  conversationDevicePickLoading: "正在读取…",
  conversationDevicePickFailed: "没选上：{message}",
  conversationDeviceSplitIntro: "命令行和浏览器可以选不同的电脑。",
  conversationDeviceNotPicked: "没选",
  conversationDeviceNotLent: "没借出",
  conversationDeviceOfflineShort: "不在线",
  conversationDeviceStoppedShort: "已停止",
  conversationDeviceBuiltInBrowser: "内置浏览器",
  conversationDevicePartOn: "{name} 的{part}",
  conversationDevicePartIs: "{part}：{name}",
  conversationDevicePartInUse: "{part}：{name}，智能体正在用",
  conversationDevicePartNotPicked: "{part}：没选电脑",
  conversationDeviceShellWaiting: "智能体在等你给命令行选一台电脑。",
  conversationDeviceBrowserWaiting: "智能体在等你给浏览器选一台电脑。",
  conversationDeviceShellNotLent:
    "{name} 现在没借出命令行。在那台电脑上打开借出，智能体才能接着用。",
  conversationDeviceBrowserNotLent:
    "{name} 现在没借出浏览器。在那台电脑上打开借出，智能体才能接着用。",
  conversationDevicePartOffline:
    "{part}：{name} 不在线（上次在线：{when}）。在那台电脑的 dodoer 里打开这个工作区，智能体才能接着用。",
  conversationDevicePartStopped:
    "{part}：{name} 的借出已从别处停止。在那台电脑上重新借出，智能体才能接着用。",
  conversationDeviceSplitPickHint: "点一下给命令行和浏览器选电脑。",
  usageChromeOn: "正在用 {name} 上的 Chrome",
  usageChromeHere: "正在用你电脑上的 Chrome",
  usageBrowserOn: "正在用 {name} 上的浏览器",
  usageBrowserHere: "正在用你电脑上的浏览器",
  usageShellOn: "正在用 {name} 的命令行（空闲的连接最多留 10 分钟）",
  usageShellHere: "正在用你电脑的命令行（空闲的连接最多留 10 分钟）",
  modelSwitchPending: "正在切换到 {to}…",
  modelSwitchAfterTurn: "本轮 {from} · 下一条 {to}",
  modelSwitchAfterTurnHint: "这轮回复继续用 {from}，下一条消息起用 {to}",
  modelSwitchApplied: "已切换模型：{from} → {to}（从下一条消息起）",
  modelSwitchFailed: "切换到 {to} 失败：{reason}，仍在用 {current}",
  modelSwitchNoAnswer: "agent 10 秒内没有回应",
  modelSwitchAgentError: "agent 报错（{detail}）",
  modelSwitchNotAdopted: "agent 没有采用",
  modelSwitchNextMark: "下一条起用",
  modelSwitchPendingMark: "正在切换",
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
  rateLimited: "請求太頻繁，稍後自動重試。",
  agentListLoading: "正在載入 Agent 列表…",
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
  queueTurnFailedReason: "這則已經送出，本輪中途失敗；重試會再送一次。",
  hostSshTitle: "把這台電腦借給智慧體",
  hostSshTooltipOn: "這台電腦已借給這個工作區的智慧體",
  hostSshTooltipOff: "這台電腦沒有借給這個工作區",
  hostSshLent: "已借出",
  hostSshNotLent: "未借出",
  hostSshHintOff:
    "借出後，「{server}」的智慧體能以你的身分在這台電腦上執行任何命令、讀寫你的檔案。只借給你信任的伺服器。",
  hostSshHintOn:
    "「{server}」的智慧體可以以你的身分在這台電腦上執行命令（它們用 `ssh` 加這台電腦在裝置列表裡的名字），只在這個視窗開著時有效。",
  hostSshAwake: "借出期間這台電腦不會睡眠（接著電源時）。",
  hostSshStopped:
    "已從別的裝置停止借出：命令列、瀏覽器和 Chrome 都不再借給「{server}」，只能在這台電腦上重新借出。",
  hostSshLendAgainHint:
    "「重新借出」依瀏覽器和 Chrome 各自的開關恢復；命令列要再點下面的「借出這台電腦」。",
  hostSshLendAgain: "重新借出",
  hostSshStoppedToast: "已從別的裝置停止借給「{server}」。",
  hostSshTooltipStopped: "已從別的裝置停止借出",
  hostSshServerNotReady:
    "這台伺服器現在還連不到借出的電腦，要等 Cowork 升級。目前借出只是把這台電腦這一側準備好，只有自我檢查會登入進來。",
  hostSshNotRunning: "SSH 服務沒有啟動：{detail}",
  hostSshLend: "借出這台電腦",
  hostSshStop: "停止借出",
  hostSshWorking: "處理中…",
  hostSshSelfTest: "自我檢查",
  hostSshTesting: "檢查中…",
  hostSshSelfTestOk: "自我檢查通過：能登入、能執行命令。找得到的工具：{tools}",
  hostSshSelfTestNoTools: "沒有",
  hostSshSelfTestFailed: "自我檢查沒通過：{detail}",
  hostSshConfirmTitle: "把這台電腦借給「{server}」？",
  hostSshConfirmBody:
    "它的智慧體將能以你的身分在這台電腦上執行任何命令：讀、改、刪你的檔案，啟動軟體，使用你已登入的帳號。無法只限定某個資料夾。隨時可以點這個圖示停止借出。",
  hostSshConfirm: "借出",
  hostSshCancel: "取消",
  hostSshPermissions: "macOS 權限",
  hostSshPermScreenRecording: "螢幕錄製",
  hostSshPermAccessibility: "輔助使用",
  hostSshPermGranted: "已授權",
  hostSshPermMissing: "未授權或已失效",
  hostSshPermFix: "修復",
  hostSshPermHint:
    "智慧體經 SSH 執行的命令，用的是 dodoer 的權限。dodoer 更新後，系統設定裡的開關可能還亮著，實際已經失效。點「修復」會清掉舊授權，並跳出系統的授權視窗：在那裡允許 dodoer，macOS 會要求重開 dodoer。注意：授權後，這台電腦上本機工作區的智慧體也能用這些權限。",
  hostSshPermNotSelf:
    "dodoer 是從別的程式（例如終端機）裡啟動的，這裡顯示的是那個程式的權限，在這裡修復不了。從「應用程式」打開 dodoer 再看。",
  hostSshPermAsked:
    "已送出授權請求。在系統設定裡打開 dodoer 的開關，依提示重開 dodoer，之後這裡會更新。",
  hostSshPermFixFailed: "修復失敗：{detail}",
  feedback: "回報問題",
  feedbackHint:
    "寫下遇到了什麼。會一起送出：目前開啟的對話的編號、版本號、連線狀態；不會帶上對話內容。你寫的文字裡的路徑和權杖會被移除。",
  feedbackPlaceholder: "例如：送出訊息後一直顯示進行中",
  feedbackSend: "送出",
  feedbackCancel: "取消",
  feedbackSent: "已送出，謝謝！",
  feedbackNotSent: "沒有送出：這台伺服器沒有開啟診斷資料回報。",
  devicesTitle: "裝置",
  devicesIntro: "連過這個工作區的電腦都在這裡。名字是你和智慧體稱呼它的方式。",
  devicesEmpty: "還沒有電腦連過。",
  devicesThis: "這台",
  devicesOnline: "在線",
  devicesLastSeen: "上次在線：{when}",
  devicesLendsShell: "命令列",
  devicesLendsBrowser: "瀏覽器",
  devicesLendsChrome: "Chrome",
  devicesLendsNothing: "沒有借出",
  devicesRename: "改名",
  devicesSave: "儲存",
  devicesCancel: "取消",
  devicesForget: "刪除",
  devicesForgetConfirm: "從列表裡刪除 {name}？",
  devicesNameLabel: "名字",
  devicesNameRule:
    "只能用小寫字母、數字和短橫線，開頭和結尾是字母或數字，最多 32 個字元。",
  devicesNameTaken: "已經有裝置叫 {name}。",
  devicesFailed: "沒改成：{message}",
  devicesUnnamedHosts:
    "還有 {count} 個舊版 dodoer 連著，那台更新後才會出現在這裡。",
  devicesNameTitle: "幫這台電腦取個名字",
  devicesNameBody:
    "你和智慧體會用這個名字稱呼這台電腦。之後可以在側欄底部的裝置圖示裡改。",
  devicesNameConfirm: "就用這個",
  devicesNameSkip: "跳過",
  devicesStop: "停止借出",
  devicesStopConfirm:
    "停止 {name} 的所有借出？智慧體在那台電腦上正在跑的會斷開，之後只能在那台電腦上重新借出。",
  devicesStopped:
    "已從別處停止借出。要在那台電腦上重新借出（那台的 dodoer 是舊版的話要先更新）。",
  devicesInUse: "正在用它的對話：{titles}",
  devicesUntitled: "未命名",
  conversationDeviceWorksOn:
    "這個對話的智慧體在 {name} 上操作。要換，跟它說用哪台。",
  conversationDeviceOffline:
    "{name} 不在線（上次在線：{when}）。在那台電腦的 dodoer 裡開啟這個工作區，智慧體才能接著用。",
  conversationDeviceLendsNothing:
    "{name} 現在命令列和瀏覽器都沒借出。在那台電腦上開啟借出，智慧體才能接著用。",
  conversationDeviceWorksOnPick:
    "這個對話的智慧體在 {name} 上操作。點一下換一台電腦。",
  conversationDevicePick: "選電腦",
  conversationDevicePickHint: "選這個對話的智慧體用你的哪台電腦。",
  conversationDeviceNeedsPick: "智慧體在等你給這個對話選一台電腦。",
  conversationDevicePickTitle: "這個對話用的電腦",
  conversationDevicePickIntro:
    "智慧體只在你選的這台上跑命令、開網頁，直到你在這裡換一台，或者在對話裡讓它換。",
  conversationDevicePickNone: "不用電腦",
  conversationDevicePickLoading: "正在讀取…",
  conversationDevicePickFailed: "沒選上：{message}",
  conversationDeviceSplitIntro: "命令列和瀏覽器可以選不同的電腦。",
  conversationDeviceNotPicked: "沒選",
  conversationDeviceNotLent: "沒借出",
  conversationDeviceOfflineShort: "不在線",
  conversationDeviceStoppedShort: "已停止",
  conversationDeviceBuiltInBrowser: "內建瀏覽器",
  conversationDevicePartOn: "{name} 的{part}",
  conversationDevicePartIs: "{part}：{name}",
  conversationDevicePartInUse: "{part}：{name}，智能體正在用",
  conversationDevicePartNotPicked: "{part}：沒選電腦",
  conversationDeviceShellWaiting: "智慧體在等你給命令列選一台電腦。",
  conversationDeviceBrowserWaiting: "智慧體在等你給瀏覽器選一台電腦。",
  conversationDeviceShellNotLent:
    "{name} 現在沒借出命令列。在那台電腦上開啟借出，智慧體才能接著用。",
  conversationDeviceBrowserNotLent:
    "{name} 現在沒借出瀏覽器。在那台電腦上開啟借出，智慧體才能接著用。",
  conversationDevicePartOffline:
    "{part}：{name} 不在線（上次在線：{when}）。在那台電腦的 dodoer 裡開啟這個工作區，智慧體才能接著用。",
  conversationDevicePartStopped:
    "{part}：{name} 的借出已從別處停止。在那台電腦上重新借出，智慧體才能接著用。",
  conversationDeviceSplitPickHint: "點一下給命令列和瀏覽器選電腦。",
  usageChromeOn: "正在用 {name} 上的 Chrome",
  usageChromeHere: "正在用你電腦上的 Chrome",
  usageBrowserOn: "正在用 {name} 上的瀏覽器",
  usageBrowserHere: "正在用你電腦上的瀏覽器",
  usageShellOn: "正在用 {name} 的命令列（閒置的連線最多留 10 分鐘）",
  usageShellHere: "正在用你電腦的命令列（閒置的連線最多留 10 分鐘）",
  modelSwitchPending: "正在切換到 {to}…",
  modelSwitchAfterTurn: "本輪 {from} · 下一則 {to}",
  modelSwitchAfterTurnHint: "這輪回覆繼續用 {from}，下一則訊息起用 {to}",
  modelSwitchApplied: "已切換模型：{from} → {to}（從下一則訊息起）",
  modelSwitchFailed: "切換到 {to} 失敗：{reason}，仍在用 {current}",
  modelSwitchNoAnswer: "agent 10 秒內沒有回應",
  modelSwitchAgentError: "agent 報錯（{detail}）",
  modelSwitchNotAdopted: "agent 沒有採用",
  modelSwitchNextMark: "下一則起用",
  modelSwitchPendingMark: "正在切換",
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
