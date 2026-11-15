# 对话的「正在用你的电脑」标记

状态：2026-11-15 设计稿。后端（判定、事件、接口）和前端（侧栏、对话标题栏）各一个 PR，见文末。

## 1. 要什么

用户（2026-11-15）：一个对话在操作 Chrome、或在用借出的 SSH 时，在这个对话的**侧栏那一行**和**顶部的标签页**（这里是对话的标题栏，见第 4 节）上都加一个状态，让人一眼看出「这个对话正在用我的 Chrome / 我的电脑的命令行」。

## 2. 「正在用」怎么判定

都在服务器（或桌面 app 自己的 daemon，`local_daemon`）上判定：智能体的调用都经过它，它知道是哪个对话、去哪台设备。

| 类型 | 算「正在用」 | 什么时候消失 |
|---|---|---|
| 浏览器 | 这个对话有一个 `browser_*` 调用正发往一台设备、还没回来 | 最后一个调用回来后 **30 秒**（`BROWSER_LINGER`）。智能体一步一步点页面，每步之间有间隔，不让标记一闪一闪 |
| 命令行 | 这个对话有一条开着的 SSH 通道（`ssh <设备名>` 经 `/api/cli_host_tunnel`） | 通道关了就消失，不留 |

- **浏览器的调用者**：监听端本来就用 `working_device::as_caller` 给每个浏览器调用包上智能体的连接编号（#259）。记录的位置是真正发出去的地方：服务器上是 `RemoteHostBrowser::ask_host`（发给哪台设备的哪个窗口），桌面 app 自己的 daemon 是 `HostBridgeClient`（发给本机 app）。`browser_list_tabs` 也算：它读的是人的浏览器。
- **Chrome 还是内置浏览器**：服务器上看那台设备有没有开「让智能体用我的 Chrome」（`chrome` 能力）：开着时智能体开的网页在 Chrome 里，标记写 Chrome；没开写「浏览器」。本机 daemon 不知道 app 里这个开关，写「浏览器」。
- **SSH 怎么对到对话**：服务器给每个智能体进程和它跑的命令设了 `CODEG_CLI_CALLER`（值是连接编号），`ssh <设备名>` 的 `ProxyCommand`（`codeg-cli desktop proxy --device`）把它带到 `?caller=`（#259 起就有，用来按对话拦）。服务器由连接编号找到对话。共用连接也是按对话分的（`ControlPath …-${CODEG_CLI_CALLER}`），所以一条通道只属于一个对话，对应是精确的。
- **委派出去的子对话**：记在它自己和最上面那个对话上，两处都显示。侧栏一般只看得到最上面那个。

## 3. 怎么传到前端

照侧栏后台状态（`conversation://background`，#226）的做法：

- 事件 `conversation://device-usage`，一个对话一条：`{conversationId, uses: [{kind, device, chrome, since}]}`，`uses` 为空就是清掉。`kind` 是 `browser` 或 `shell`；`device` 是设备名，本机 daemon 里是空（这台电脑）；`chrome` 只在知道时有。
- 接口 `POST /api/list_session_usage`：现在的全部。窗口打开、WebSocket 重连后读一次。
- 服务器发事件走 `emit_event`，网页、手机、桌面 app 的远端窗口都在同一条 `/ws/events` 上收到；本机窗口连的是 app 自己的 daemon，也一样。老服务器没有这个接口，前端读失败就什么都不显示。

## 4. 长什么样

- 一个小图标，和 PR 标记、目标标记同一排、同样大小（`h-3 w-3`），在它们左边，天蓝色：浏览器用 `Chrome`（知道是 Chrome）或 `Globe`，命令行用 `SquareTerminal`。两样都在用就两个图标。
- 悬停：「正在用 laptop 上的 Chrome」「正在用 desktop 的命令行（空闲后最多 10 分钟才断开）」；不知道设备名时写「你的电脑」。
- 侧栏：放在行右边的状态区里，PR 标记前面，不挤掉未读点、黄色「等你回答」、后台沙漏、时间。和它们一样，鼠标移上去换成置顶、完成按钮时暂时藏起来。
- 顶部：这个产品没有会话标签栏（jenny 删了，`tabs/tab-bar.tsx` 没人用），「上面那一栏」是对话的标题栏（`conversation-detail-header.tsx`），标记放在标题后面，图标大一号（`h-3.5`）。
- 文字在 `src/lib/cowork/i18n.ts`（英、简、繁）。

## 5. 局限

- **SSH 的共用连接空闲后还留 10 分钟**（`ControlPersist 10m`）。这段时间通道开着，标记也在：智能体随时能不经确认再跑命令，所以照实显示。tooltip 里写明。按字节判断「真的在跑」靠不住：`ServerAliveInterval 30` 的心跳也有字节，一条安静的长命令又没有。
- 人在服务器终端里自己敲的 `ssh`（没有 `CODEG_CLI_CALLER`）不算任何对话，不显示。
- 本机 daemon 不分 Chrome 和内置浏览器。
- 桌面 app 的嵌入模式（`CODEG_DESKTOP_DAEMON=embedded`，留作退路）没有这个标记。
- 服务器重启后从空开始；开着的通道本来也断了。

## 6. 放弃的方案

- **前端自己从 `browser://agent-activity` 推**：那个事件按标签发、只在本机 app 里，不带对话，服务器上的智能体用借出的浏览器时网页里也收不到。
- **看智能体的 Bash 工具调用里有没有 `ssh <名字>`**：能做到「命令跑完就消失」，但要解析命令文本，`scp`、脚本里的 `ssh`、别名都会漏或误判。
- **复用设备面板的「正在使用」（`inUse`）**：那是「工作设备是它、对话开着」，不是此刻在用。

## 7. 分步

1. 后端：`web/session_usage.rs`（记录、事件、接口），挂到 `ask_host`、`HostBridgeClient`、SSH 通道；Rust 单测。
2. 前端：`src/lib/cowork/session-usage.ts`（store、同步）、`src/components/cowork/session-usage-mark.tsx`，接进侧栏行和对话标题栏；vitest。

要在 Mac 上验：服务器上的智能体在 Mac 的 Chrome 里开网页时，网页和 Mac 的远端窗口里侧栏、标题栏都出现 Chrome 图标，停手 30 秒后消失；`ssh <名字>` 跑命令时出现命令行图标，共用连接断开（或 `ssh -O exit`）后消失；本机窗口里本机智能体用浏览器时出现「浏览器」。
