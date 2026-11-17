# 遥测：看清「哪里坏了、是谁的问题」

状态：第 1 步（服务端，`src-tauri/src/telemetry/`）、第 2 步（前端，`src/lib/telemetry/`）、第 3 步（对话收尾和「反馈问题」）、桌面端崩溃和卡死（第 5.11 节）已写。2026-11-15 起**默认开、可以关**：发版的包里编进了上报地址（第 5.1 节、第 10 节「默认开」）。实现和下面方案不一样的地方记在第 10 节。

## 1. 问题

现在知道产品出问题只有三条路：用户自己说、AI QA 每晚点一遍、事后翻服务器日志。三条都有盲区：

- 用户遇到问题多半刷新一下就过去了，不会说。
- AI QA 的环境每晚重建，agent 一轮两秒就结束，全在一台机器上，碰不到长会话、掉线、升级后的旧数据。
- 服务器日志只有服务器这一头。实时连接断了，分不清是用户关了标签页、中间网络抖了，还是服务端的问题；浏览器里的报错根本到不了服务器。

具体例子：断开连接的接口有三成返回 500，访问日志里每天都有，一周后才被 AI QA 撞见（#201）；「回复完了界面还显示进行中」（#172）专门重试四次都没复现，原因至今没查到。

## 2. 目标和不做的

目标：每个问题发生时，浏览器和服务器两头都留下记录，能对上是同一次操作，从而回答三个问题——

1. **哪里坏了**：前端报错、接口 5xx、服务端 ERROR，自动归类计数，新出现的第一时间知道。
2. **是谁的问题**：同一次接口调用，浏览器测到的耗时减去服务器处理的耗时，就是花在网络上的时间；实时连接每次断开记下原因和恢复用了多久。
3. **影响多大**：多少人、多少次、哪个版本开始的。

约束：

- **默认开，可以关。**（2026-11-15 起；最初是默认关、安装包里不带上报地址。）发版的服务端包和桌面 app 里编进了两个上报地址（服务端项目、前端项目），不用配置就上报；一个环境变量（`CODEG_TELEMETRY=off`）或桌面端设置里的一个开关就全关。自己编的、PR 和测试的构建不带地址，和以前一样是关的。部署自己配了上报地址的（我们的生产机）照旧用自己的，行为不变。
- **别人机器上不带人名。** 用内置地址上报时，用户标识是数据目录里随机生成的安装编号，不是系统用户名；environment 是 `community` / `desktop-local`，和生产机的 `production` 分开看。
- **不采内容。** 对话、代码、文件内容、终端输出、文件路径一律不上报（第 5.7 节）。
- **不在服务器上装常驻的采集程序。** 生产机内存紧，上报嵌在 codeg-server 进程里。
- **费用封顶。** 用量有上限，超了就丢，不会多花钱（第 5.8 节）。

不做：

- 用户行为分析（哪些功能没人用、哪一步放弃）和录屏。那是另一类工具（PostHog）的事，等有了多个真实用户再接；前端留了统一的入口，到时不用再改各处调用。
- 机器指标（CPU、内存、磁盘）的长期曲线。侧栏的资源表已经能看当前值。
- 手机 App。桌面端的远端窗口跑的是同一份前端，自动带上；桌面端自己的崩溃和卡死、本机工作区（app 自带的 `codeg-server` 和本机窗口）2026-11-15 起也报（第 5.11 节）。
- 桌面端「内嵌 daemon」模式（`CODEG_DESKTOP_DAEMON=embedded`，以及开了「随 app 启动网页服务」时）：daemon 在 app 自己的进程里，桌面主程序不链接 Sentry，这种模式下本机后端不报（崩溃和卡死照样报，前提是连着一台会上报的 Cowork 服务器）。

## 3. 一句话方案

用 Sentry。codeg-server 进程内直接上报服务端的错误、接口耗时和连接日志；前端的遥测不直接连 Sentry，而是走 codeg 自己的接口，由 codeg-server 转发出去。上报地址来自服务器的环境变量，没有就用发行包编进去的；前端从 `cowork_info` 得知要不要开，自己不带地址。

```
浏览器 / 桌面端远端窗口                    codeg-server（每个员工一个进程）            Sentry
┌──────────────────────────┐            ┌─────────────────────────────────┐
│ src/lib/telemetry（入口）  │  POST      │ /api/telemetry_envelope          │  HTTPS
│  └ sentry.ts（按需加载）   │ ─────────▶ │  校验、限速、转发                  │ ───────▶ 前端项目
│ 接口调用带 sentry-trace 头 │ ─────────▶ │ http 中间件：续上同一条追踪         │
└──────────────────────────┘            │ tracing 的 ERROR / 选定的日志      │ ───────▶ 服务端项目
                                        └─────────────────────────────────┘
```

选 Sentry 的理由：Rust、浏览器两头都有成熟的 SDK，两头的记录能串成一条；嵌在进程里上报，不用另装采集程序；codeg 已经用 `tracing` 打日志，能直接接上；免费档够现在的量，付费档每月二十几美元。

## 4. 已核实的事实（2026-11-14）

- Rust 端 `sentry` 0.49.5：`sentry-tracing` 提供四个独立的层——`ErrorLayer`（tracing 的事件变成 Sentry 的错误）、`BreadcrumbLayer`（变成面包屑）、`LogLayer`（变成结构化日志，要 `logs` feature）、`SpanLayer`（tracing 的 span 变成追踪）。传输层用 reqwest，仓库里已有 reqwest 0.12。
- 浏览器端 `@sentry/browser` 11.12.0：可以换传输层（`transport` 选项，收到的是整个信封）、有离线缓存的传输层包装、结构化日志（`Sentry.logger`）、不用自带界面也能提交用户反馈（`captureFeedback`）。
- 日志怎么建的：`src-tauri/src/logging/init.rs` 的 `build_subscriber` 是所有二进制共用的唯一入口；`codeg-server` 的 `main` 是同步的，自己建 tokio runtime，环境变量在 `cowork::init_process_env` 里读、读完从进程环境里删掉。
- 接口请求已经有一层中间件给每个请求开 `http` span（method、path、request_id），在 `web/router.rs` 末尾。接口报错统一经 `web/handlers/error.rs` 的 `IntoResponse for AppCommandError` 变成响应。
- 前端所有接口调用都过 `Transport.call(command, args)`：网页版是 `WebTransport`（直接 `fetch`），桌面端的远端窗口是 `RemoteDesktopTransport`（经桌面端 Rust 代理转发）。实时连接的建立、断开、重连都在 `WebTransport.connectWs` / `scheduleReconnect` / `setConnState` 里。
- 前端已经有「这是不是 Cowork 服务器」的一次性询问：`src/lib/cowork/info.ts` 的 `loadCoworkInfo()`，对应服务端 `cowork.rs` 的 `CoworkInfo`。
- 前端是静态导出（`output: "export"`），没有 CSP，现在的包里不带源码映射文件。全局只有一段内联脚本过滤 ResizeObserver 报错，没有渲染错误的兜底页。
- 服务端的发行版本不在二进制里（`CARGO_PKG_VERSION` 是上游的版本号），在安装目录的 `COWORK-VERSION` 文件里；前端构建时已经把它编进了 `CODEG_RELEASE_VERSION`。
- 用量：按一个真实用户一周的访问日志折算，每月约 117 万次接口调用，其中 85% 是三个轮询接口（`acp_touch_connection`、`get_git_head`、`get_codeg_mcp_service_status`）。去掉轮询每人每月约 17 万次。

## 5. 设计

### 5.1 开关和配置

环境变量（`COWORK_<X>` 是 `CODEG_<X>` 的别名，两个都设时 `CODEG_` 的说了算），加上发版构建编进去的两个上报地址。环境变量读完从进程环境里删掉，agent、终端这些子进程看不到。

**每一半（服务端项目、前端项目）的上报地址从哪来**，从上往下第一条成立的算（`src-tauri/src/telemetry/config.rs`）：

| # | 条件 | 结果 |
|---|---|---|
| 1 | `CODEG_TELEMETRY=off`（或 `0`、`false`、`no`） | 两半都关 |
| 2 | 这一半的变量设了值：`CODEG_TELEMETRY_DSN` / `CODEG_TELEMETRY_WEB_DSN` | 用它（来源：环境） |
| 3 | 这一半的变量设了，但是空的（`CODEG_TELEMETRY_DSN=`） | 这一半关 |
| 4 | 这一半没设，另一半的变量设了值 | 这一半关：部署自己配了 Sentry，没配的那一半不掺我们内置的 |
| 5 | 这个构建编进了地址（`CODEG_TELEMETRY_BUILTIN_DSN` / `_WEB_DSN`，编译时） | 用内置的（来源：内置） |
| 6 | 都没有 | 关 |

「没设」和「设成空」是两回事：systemd 的 `Environment=CODEG_TELEMETRY_DSN=` 或者 shell 里 `export CODEG_TELEMETRY_DSN=` 算设成空，只关服务端那一半；整个关用 `CODEG_TELEMETRY=off`。启动日志里有一行写明每一半是开着（来源：环境 / 内置）还是关着、为什么，例如 `[telemetry] server reports on (built in), web reports off (CODEG_TELEMETRY=off)`。

**内置地址**：发版的 workflow 在 `cargo build` 那一步的环境里给 `CODEG_TELEMETRY_BUILTIN_DSN`、`CODEG_TELEMETRY_BUILTIN_WEB_DSN`（公开仓库 Tinghecui/dodoer-releases 的 Actions secret），`option_env!` 把它编进 `codeg-server`。只有真要发布的那次构建给：`cowork-release.yml` 的 `backend`（tag 或调用方给了 `version`，即手动 tag 和 release-train），`desktop-macos.yml` 的 `build`（`publish` 为真）。`pr/**`、`qa/**`、`macos/pr/**`、每晚、Test 的构建都不给，编出来的和本地一样是关的；公开仓库没有 `pull_request` 触发的 workflow，fork 的 PR 拿不到。包的冒烟测试带着 `CODEG_TELEMETRY=off` 起服务，不上报，也不在日志里打出地址。

**其他变量**：

| 变量 | 作用 |
|---|---|
| `CODEG_TELEMETRY` | 总开关，`off` / `0` / `false` / `no` 全关。别的值（含空）不起作用。 |
| `CODEG_TELEMETRY_DSN` | 服务端项目的上报地址，见上表。服务端这一半关着时 Sentry 客户端不初始化。 |
| `CODEG_TELEMETRY_WEB_DSN` | 前端项目的上报地址，见上表。关着时 `cowork_info` 里没有遥测配置，前端不加载遥测代码，转发接口回 404。 |
| `CODEG_TELEMETRY_ENV` | 环境名。默认：用环境变量的地址时 `production`；用内置地址时 `community`，桌面 app 自带的 daemon（环境里有 `CODEG_DESKTOP_CHILD=1`）是 `desktop-local`。AI QA 的环境设 `ai-qa`。 |
| `CODEG_TELEMETRY_TRACES` | 接口追踪的抽样率，0 到 1，默认 1。量大了往下调。 |
| `CODEG_TELEMETRY_USER` | 这个进程的用户标识。默认：用环境变量的地址时是系统用户名去掉 `cw-` 前缀（生产机，和以前一样）；用内置地址时是安装编号（第 5.7 节）。 |
| `CODEG_TELEMETRY_RELEASE` | 上报用的 release（服务端事件和给前端的 `cowork_info.telemetry.release` 同一个）。不设时服务器读程序旁边的 `COWORK-VERSION`（`cowork-codeg-vX.Y.Z`），没有就是上游版本 `codeg@<版本>`；桌面 app 自带的 daemon 由 app 给 `dodoer-desktop@<桌面版本>`，和崩溃报告同名。 |

`CoworkInfo` 多一个可空的字段，前端据此决定开不开。服务端用内置地址时照样给出去，前端自己不内置地址：

```jsonc
"telemetry": {
  "dsn": "…",              // 前端项目的地址（环境变量或内置的）
  "environment": "production",
  "release": "cowork-codeg-v0.6.0",   // CODEG_TELEMETRY_RELEASE，没设读 COWORK-VERSION，再没有是 codeg@<上游版本>；桌面自带的 daemon 是 dodoer-desktop@<桌面版本>
  "tracesSampleRate": 1,
  "user": "james"
}
```

上游服务器没有 `cowork_info`，前端的遥测保持关闭。桌面端本机工作区的窗口只问 app 自带的 daemon 要 `cowork_info.telemetry` 这一项（第 5.11 节）。

### 5.2 服务端：`src-tauri/src/telemetry.rs`

新加一个模块，对外只有几个函数；Cargo 加 `telemetry` feature（`server-bin` 带上它），不开这个 feature 时这些函数都是空实现，桌面端和上游的构建不链接 Sentry。

```rust
/// main 里读完环境变量后、建日志和 tokio runtime 之前调用。返回的 guard 活到进程结束。
pub fn init_server(settings: &CoworkSettings) -> TelemetryGuard;

/// 给 build_subscriber 用。init_server 没成功（没配置、别的二进制）就是 None。
pub fn tracing_layers<S>() -> Option<impl Layer<S>>;

/// 包住一次接口请求：续上浏览器传来的追踪，记耗时和状态。
pub async fn trace_request(req: Request, next: Next) -> Response;

/// POST /api/telemetry_envelope：把前端的信封转发给 Sentry。
pub async fn forward_envelope(Json(p): Json<EnvelopeParams>) -> Result<Json<EnvelopeResult>, AppCommandError>;

/// 给 CoworkInfo 用。
pub fn client_config() -> Option<ClientTelemetry>;
```

改到上游文件的地方只有四处，每处几行：

1. `bin/codeg_server.rs`：`init_process_env` 之后加一行 `let _telemetry = telemetry::init_server(...)`。
2. `logging/init.rs` 的 `build_subscriber`：两个分支各加一行 `.with(telemetry::tracing_layers())`（`Option<Layer>` 本身就是 Layer）。
3. `web/router.rs`：现有的 `http` 中间件里，把 `next.run(req).instrument(span)` 包进 `telemetry::trace_request`。
4. `web/handlers/error.rs`：`into_response` 把错误码和消息放进响应的 extensions，供第 3 处读。

**日志怎么映射**（三个层，各带过滤器）：

- `ErrorLayer`：所有 ERROR。现有的 panic 钩子也是经 tracing 打 ERROR，所以 panic 走同一条路，不再开 Sentry 自己的 panic 集成（否则一个 panic 报两次）。
- `BreadcrumbLayer`：INFO 和 WARN。只在后面出了错误时作为上下文带上。一个进程只服务一个员工，面包屑不会串到别人身上。
- `LogLayer`：WARN 以上，加上名单里的几个模块的 INFO——实时连接（`web::ws` 的 open / closed / attach）、连接状态变化（`acp::session_state`）、连接的建立和回收（`acp::manager`、`acp::idle_sweep`）、桌面端在不在（`web::host_registry`）。这些是「谁断的」要用的，量很小（一个用户一周几千行）。
- **不用 `SpanLayer`。** 现有的 `connection{…}` span 和 agent 连接同寿命，一开几小时，字段里还带工作目录；自动转成追踪既没用又泄露路径。接口追踪手工建（下一条）。

**接口追踪**（`trace_request`）：

- 每个请求建一个 Sentry 事务，名字是 `POST /api/<命令>`；请求头里有 `sentry-trace` 就续上那条追踪和它的抽样决定，没有（手机 App、codeg-cli、agent 的 MCP 调用）就按自己的抽样率。标签带上现有的 `request_id`，Sentry 里的一条记录能回到日志文件里的同一个请求。
- 每个请求绑一个独立的 hub，并发请求的标签互不污染。
- 轮询接口按 1% 抽样；`telemetry_envelope` 自己不追踪。名单只在 Rust 里（`config::POLLED_COMMANDS`），经 `cowork_info` 发给前端，两边一致（见第 10 节「轮询名单不放共享的 JSON 文件」）。名单里是网页端定时重发的命令：
  - 一直在跑的：第 4 节那三个，加 `get_system_resources`、`list_host_devices`、`health`、`get_conversation_device`（每个打开的对话 10 秒一次）、`folder_pr_statuses` / `conversation_pr_statuses`（侧栏 PR 标记，20 秒一次）；
  - 面板、对话框开着时才跑的：`get_jenny_progress`、`get_loop_conversation`、`get_loop_session_page`、`get_conversation`（子 agent 对话框）、`read_workbench_app_log`、`git_list_conflicts`、`forge_auto_status`、`renew_office_watch`、`codex_poll_device_code`、`weixin_check_qrcode`。
  - 用户打开对话时读的 `get_folder_conversation` 不在名单里（回合结束后的几次补读也是有限次的退避，不是定时轮询）。2026-11-16 前 `get_conversation_device` 和两个 PR 状态接口按 1.0 全采，8 小时里占了网页事务的大头，把转发的普通额度（每分钟 60 个信封）打满，同一时段的网页报错被浏览器限速丢掉。
  - 新加定时轮询的命令时，把它加进名单。
- 响应是 5xx：上报一条错误，按「命令 + 错误码」归类，消息过脱敏。#201 那种「日志里没有 ERROR、但接口回了 500」的情况就不会再漏。
- 响应是 501（接口不存在）：记一条日志，带命令名和前后端版本。新旧版本交接时的不匹配就能数出来。

**进程退出**：guard 在 `main` 末尾 drop 时最多等 2 秒把队列发完；panic 钩子里同样等一下。

### 5.3 前端：`src/lib/telemetry/`

| 文件 | 内容 |
|---|---|
| `index.ts` | 入口，不依赖 Sentry。各处只调它：`reportError`、`beginApiCall`、`noteWs`、`turnStarted` / `turnSettled`、`sendFeedback`。没开时全是空操作；开之前捕到的错误先缓存最多 20 条。 |
| `sentry.ts` | 唯一 import `@sentry/browser` 的文件，用 `import()` 按需加载，单独一个 chunk。没开遥测的用户不下载它。 |
| `transport.ts` | 自定义传输层：把信封交给 `getTransport().call("telemetry_envelope", …)`（第 5.4 节）。 |
| `scrub.ts` | 脱敏（第 5.7 节）。 |

启动：`loadCoworkInfo()` 拿到结果后，`telemetry` 字段非空就加载 `sentry.ts` 并初始化。只这一个触发点。

初始化的要点：

- 只开全局错误捕获、页面加载追踪和面包屑；**关掉** SDK 自带的 fetch / XHR 追踪和控制台面包屑——接口调用我们自己在 `Transport.call` 里记（这样轮询不会淹没数据），控制台输出里可能有内容。
- 点击面包屑只保留元素类型和 `data-testid`，不带 `title`、`aria-label` 这类可能含会话标题的属性。
- 不开录屏，不发 IP、cookie、请求体。
- 用户标识用 `telemetry.user`；标签带 `surface`（网页 / 桌面端远端窗口）、前端版本、服务端版本。
- 每个页面会话最多上报 30 条错误，60 秒内相同的只报一次。

埋点（改到的上游文件和位置）：

| 位置 | 记什么 |
|---|---|
| `WebTransport.call`、`RemoteDesktopTransport.call` | 每次调用一个 span：命令、耗时、结果（成功 / HTTP 状态 / 超时 / 网络失败）。网页版把追踪头带给服务器。轮询接口同样按 1% 抽样，但失败（5xx、超时、网络失败）总是记一条日志。 |
| `WebTransport.connectWs` 的 `onopen` / `onclose`、`setConnState`、`noteNetworkLost` | 连接多久建成；断开时的关闭码、是否正常关闭、活了多久、页面当时是否可见、浏览器是否认为在线；每次「重连中 → 已连接」记成一个 span：断了多久、试了几次。`onclose` 现在不收事件参数，要改成收。 |
| `conversation-detail-panel.tsx`、`stranded-turn.ts` | 一轮对话从发出到界面收尾的时长、多久收到第一个事件、期间断过几次连接、是怎么收尾的。**由兜底逻辑收尾的（也就是 #172 的现场）单独报一条警告**，这样它出现了几次、在谁身上、哪个版本，都有数。 |
| 新增 `src/app/global-error.tsx` | 渲染崩溃时上报，并给一个「刷新」按钮，代替现在的白屏。这个页面对所有用户生效，不只是开了遥测的。 |
| 账户菜单（开了遥测才显示） | 「反馈问题」：一个输入框，提交时自动带上当前会话号、版本、连接状态。 |

### 5.4 上报通道：经自己的服务器转发

前端不直接连 Sentry。自定义传输层把每个信封作为一次普通的接口调用发给 `POST /api/telemetry_envelope`，codeg-server 转发。

为什么：

- 鉴权、限速、nginx 配置都是现成的，Cowork 仓库不用为此改 nginx。
- 广告拦截插件和不稳定的跨境网络拦不到它（请求发往自己的域名）。
- 桌面端的远端窗口不用特殊处理：它的接口调用本来就经桌面端的 Rust 代理到服务器。
- Sentry 看到的来源地址是服务器，不是用户。

服务端的转发做四件事：没配 `CODEG_TELEMETRY_WEB_DSN` 回 404；信封头里的 DSN 必须等于配置的那个，否则 400（不当开放代理）；单个信封最大 256 KB，进程内每分钟最多 60 个，带报错的信封另有每分钟 30 个的额度，超了回 429；把 Sentry 回的限速头原样带回前端，SDK 自己会退避。自己的 429 也带限速头 `X-Sentry-Rate-Limits`，写明停哪几类：没带报错的信封超了只停性能、日志这几类，带报错的超了只停报错。光回一个 429 的话，浏览器的 SDK 会把所有类型都停一分钟，报错也一起丢掉。2026-11-15 就这样丢过 4 条：在后台放了一夜的桌面窗口醒来以后，一下子把攒着的信封都补发出来。

转发拒掉或被限流时留 WARN：自己的额度超了，每个额度每分钟记第一条（写明是报错额度还是普通额度、每分钟多少、还要停几秒）；Sentry 回了 429 或限速头，每分钟记第一条（状态码、限速头、retry-after 原文）。这几条除了写本地日志，还作为日志发到服务端项目（`telemetry` 模块自己的行一般不进 Sentry），所以在 Sentry 里就能看出浏览器为什么对报错退避。它们走服务端自己的发送线程，不经过转发，每分钟最多各一条，不会自己放大自己。

浏览器 SDK 什么时候停发报错（11.12 的 `updateRateLimits`）：限速头里点名 `error` 或类别为空（等于全部）；没有限速头但有 `retry-after`；两个都没有但状态是 429。现在的转发只有两处会让它停报错：报错额度（每分钟 30 个）用完，和 Sentry 自己的限速头。502、拒收（400/404）都不会：502 时离线缓存留着信封以后补发，拒收直接丢。

断网时前端发不出去：传输层外面包一层离线缓存（存在 IndexedDB），恢复后补发。所以「断网那一刻发生了什么」不会丢。

### 5.5 采哪些信号

| 信号 | 来源 | 在 Sentry 里是什么 | 回答什么 |
|---|---|---|---|
| 前端报错、渲染崩溃 | 浏览器 | 错误 | 哪里坏了 |
| 服务端 ERROR、panic | 服务器 | 错误 | 哪里坏了 |
| 接口 5xx | 服务器 | 错误，按命令和错误码归类；`database_error` 在消息后面带数据库原话（引号里的换成 `?`、数字换成 `N`、最多 200 字） | 哪里坏了 |
| 接口耗时（两头） | 浏览器 + 服务器，同一条追踪 | 追踪 | 慢在网络还是服务端 |
| 接口超时、网络失败、501 | 浏览器 | 日志。超时和网络失败（服务器没有回应）：页面隐藏时只计数，重新可见时发一条「API calls failed while hidden」汇总（总数、按命令前几名、隐藏了多久）；可见时同一命令同一种失败每分钟逐条报前 5 条，其余到这一分钟结束或可见性变化时补一条「API call failed again」带次数。501 和服务器回了状态码的失败照常逐条报 | 网络问题、版本不匹配 |
| 实时连接断开和恢复 | 浏览器 + 服务器 | 日志 + span | 谁断的、断了多久 |
| 一轮对话的收尾方式 | 浏览器 | span；兜底收尾另报警告 | #172 这类状态问题 |
| 页面加载性能 | 浏览器 | 追踪 | 首屏慢不慢 |
| 用户反馈 | 浏览器 | 反馈 | 哪里难用（人说的） |
| 智能体浏览器调用失败 | 服务器（`web/host_browser.rs`） | 日志（WARN），字段 `kind`（调用种类）、`failure`（失败类别）、`device`，超时另有 `timeout_secs` | 设备没回、掉线、路由不到，还是浏览器读不了页、开不了标签页 |

智能体浏览器调用失败的类别：`timed_out`（设备没在时限内回）、`gone` / `window_gone`（窗口在回之前断了）、路由不到（`no_host`、`not_lent`、`offline`、`stopped`、`choose_device`、`unknown_device`、`unknown_tab`），以及桌面回了结果但浏览器本身失败（`browser_read_failed`、`browser_open_failed`）。标签页没共享、用户拒绝了 JS、引用过期、网站被拦这些是预期的回答，不记。只记调用种类和设备，不带网址、标签页标题、页面内容、JS 代码、文件路径。

### 5.6 版本和源码映射

- 版本号两头都用发行 tag（`cowork-codeg-vX.Y.Z`），没发版的构建带提交号。Sentry 据此标出「这个问题从哪个版本开始」。
- 前端的报错堆栈是压缩后的，要还原成源码位置得上传源码映射。做法：发版构建时生成映射 → 传给 Sentry → 从包里删掉，包里仍然不带映射文件（加一条检查）。**这等于把前端源码交给 Sentry，需要用户点头**；不传的话前端报错只能看到消息和面包屑，其余信号不受影响。放在第 2 步，不挡第 1 步。
- 服务端的错误第一版不带调用栈（要带得传调试符号，构建更慢），只有消息、日志上下文和所在的请求。

### 5.7 不采什么，怎么脱敏

永远不上报：对话和回复的文字、代码和文件内容、终端的输入输出、请求体和响应体、令牌和环境变量、会话标题、项目名、git 远程地址、用户的 IP。

上报的：命令名、状态码、耗时、错误消息（脱敏后）、版本号、用户标识、浏览器类型、连接和会话的内部编号、request_id。

两头用同一套规则，同一份测试用例（一个 JSON 文件，Rust 和前端的测试都读它）：

- 家目录下的路径（`/home/<x>/…`、`/Users/<x>/…`）整段换成 `~/<redacted>`。
- 形如令牌的串（`Bearer …`、设备令牌、32 位以上的 base64 / 十六进制串）换成 `<redacted>`。
- URL 去掉查询串和片段；邮箱换成 `<email>`。
- 名叫 `working_dir`、`cwd`、`path`、`file`、`title`、`prompt`、`text`、`content` 的字段直接丢掉。
- 消息截到 500 字符。

用户标识：生产机上是员工的登录名去掉 `cw-`（那是我们自己的服务器）。用内置地址上报的机器——别人的服务器、用户自己的 Mac——不用系统用户名（那是个人信息），用一个安装编号：第一次上报时随机生成（UUID 的前 12 个十六进制字符），存在数据目录的 `telemetry-install-id` 里，以后一直用它。同一台机器的记录能算成一个用户，但认不出是谁；删掉文件就换一个。桌面端本机工作区的 daemon、本机窗口、崩溃报告都用 daemon 的这个编号。

本机工作区的数据（2026-11-15 起也报）满是用户自己的路径和用户名，核过一遍：家目录下的路径（`/Users/<x>/…`、`/home/<x>/…`、`C:\Users\<x>\…`）整段换掉；别的三层以上的绝对路径只留第一段；面包屑和日志的消息、字段走同一套规则，`working_dir`、`cwd`、`path` 这类字段整个丢掉；事件里的主机名（`server_name`）、用户的用户名 / 邮箱 / IP 清空。没盖住的：家目录路径里带空格时，空格后面的部分会留下（`/Users/<x>/My Projects/a` 剩 `~/<redacted> Projects/a`），不含用户名。

剩下的风险：错误消息里偶尔会带项目名或分支名（比如「名为 X 的项目已存在」）。第二道防线是 Sentry 项目设置里的数据清洗和「不存 IP」，都打开；真漏了可以按条删除。

### 5.8 用量和费用上限

免费档每月：5000 条错误、500 万条 span、5 GB 日志。账号不绑付款方式，用完当月额度就丢数据，不会产生费用。

| 类别 | 估算（5 个用户） | 控制手段 |
|---|---|---|
| span | 非轮询接口每人每月约 17 万次，两头各一条，再加 1% 的轮询和页面加载，合计约 200 万 | `CODEG_TELEMETRY_TRACES` 往下调 |
| 错误 | 现在一个用户一周约 120 条（其中两类占了绝大多数，修掉就没了） | 前端每会话 30 条、服务端每分钟 60 条封顶 |
| 日志 | 每人每周几千行 | 模块名单 |

要第二个人登录 Sentry、或者要 90 天的数据保留时，升到付费的 Team 档。

### 5.9 心跳

遥测嵌在 codeg-server 里，服务器整个挂了就没人上报。所以另外要一个独立于 codeg 的心跳：系统定时器每分钟向 Sentry 的定时任务监控打一次卡，连续几次没到就告警。它说明「机器活着、出得了网」。用户到服务器这一段的质量由浏览器那头的数据回答（第 5.5 节）。

心跳属于部署，放在 Cowork 仓库，不在这个仓库里。

### 5.10 Cowork 仓库要配合的

- `codeg@.service` 加一行 `EnvironmentFile=-/etc/cowork/telemetry.env`（root 600，所有员工共用一份；文件不存在就是关）。
- 心跳的定时器。
- 门户的账户页加一段说明：这个工作区采集哪些诊断数据、不采什么。邀请别人用之前必须有。
- AI QA 的环境用 `CODEG_TELEMETRY_ENV=ai-qa` 接上：测试员点界面时前端的报错和接口 500，它自己看不到，Sentry 能看到。

### 5.11 桌面端

- 远端窗口：跑的是同一份前端，问的是它连的那台服务器的 `cowork_info`，上报经 Rust 代理走同一个转发接口。追踪头暂时带不过去（代理自己组请求头），两头的记录靠时间和 request_id 对。开不开、报到哪，跟着那台服务器走，不受桌面端的开关影响。
- 本机工作区（2026-11-15 起）：本机后端是 app 带着的 `codeg-server` 子进程（`local_daemon.rs`，默认的 child 模式），它启动时照第 5.1 节的规则开遥测——发版的包里有内置地址，所以默认开，environment `desktop-local`，用户是安装编号，release 是 app 用 `CODEG_TELEMETRY_RELEASE` 交给它的 `dodoer-desktop@<桌面版本>`（和崩溃报告同名，桌面包里没有 `COWORK-VERSION`；2026-11-17 以前是上游的 `codeg@0.43.0`），本机窗口经 `cowork_info.telemetry.release` 用同一个。本机窗口只问它要 `cowork_info.telemetry` 这一项（`loadLocalDaemonTelemetry`，`cowork_info` 的其他内容不用，本机工作区不因此变成 Cowork 工作区），有就启动前端遥测（`surface=desktop-local`），信封经子进程的 `/api/telemetry_envelope` 转发，和远端窗口走同一个代理。内嵌 daemon 模式不报（第 2 节）。
- 桌面端自己的进程：崩溃和卡死、软件更新的记录，见下面。Rust 代理的连接断开还没做。

**开关**：设置 → 通用 →「发送诊断数据（崩溃、卡死、报错）」，桌面端的总开关，**默认开**。存在 `~/.codeg/preferences.json` 的 `diagnostics`：没有这一项 = 开，只有用户自己关掉才写 `false`。关掉时：崩溃和卡死不记、不发，攒着的删掉（立刻生效）；app 下次启动子进程时给它 `CODEG_TELEMETRY=off`，本机后端和本机窗口都不报（下次启动 dodoer 后生效，开关下面写着）。#290 的 `crash_reports` 那一项不再读：它默认是 `false`，存过任何设置的文件里都有，分不出是不是用户自己关的。

#### 桌面端自己的进程：崩溃和卡死（2026-11-15）

起因：2026-11-15 dodoer 在 macOS 上应用内升级完以后卡死，两次都要强制退出，遥测里什么都没有，是靠 `/Library/Logs/DiagnosticReports/codeg_*.hang` 和 app 日志查出来的（tokio worker 被 `AppHandle::restart()` 卡住，#271 修了）。那是用户自己的电脑，所以单独征得同意。

**开关**：上面那个总开关（最初是单独的「发送桌面端崩溃和卡死报告」，默认关）。存在 `~/.codeg/preferences.json`（和「关闭硬件加速」同一个文件，启动时不用等数据库就能读）。本机窗口和远端窗口里都有（调的是桌面端自己的命令，不经服务器）。开关下面写明：默认开、可以关；发什么（崩溃、卡死、报错的类型、脱敏后的报错和代码位置、耗时、当时是否在升级或退出、版本、系统类型、安装编号；2026-11 起加上每次软件更新的结果，见下面「软件更新的记录」），发到哪（连着的 Cowork 服务器或 app 自带的本机后端，由它转给 Sentry），不发什么（对话内容、代码和文件内容、文件路径、网址、终端输出、用户名）。关掉时把本机攒着的记录全删掉。

**采什么**（都在下次启动时补报，崩溃、卡死的那一刻发不出去）。记录放在数据目录下的 `crash-reports/`（调试构建用 `crash-reports-dev/`，和装好的版本互不干扰），开关关着时什么都不写。

| 记录 | 什么时候写 | 下次启动看到它说明 |
|---|---|---|
| `run-<运行号>.json`「运行中」 | 启动时写；每分钟和应用状态变化时（开始升级、开始退出）重写，带最后活着的时间；正常退出流程（`shut_down`）的最后删掉 | 上次没走完正常退出：崩溃、被杀或被强制退出 |
| `hang-<运行号>.json`「卡死中」 | 看门狗发现某一边超过 10 秒没回心跳时写，卡着时每 5 秒更新卡了多久 | 上次是卡着被强制退出的 |
| `recovered-<运行号>-<n>.json` | 卡住的那一边又回了心跳，「卡死中」改成「卡了 X 秒后恢复」 | 卡过但自己好了（每次运行最多 3 条） |
| `panic-<运行号>-<n>.json` | panic 钩子（链在 `logging::panic_hook` 后面），写原始消息、位置、线程名、版本 | panic 过（每次运行最多 3 条；tokio 任务里的 panic 不会让进程退出） |

- **看门狗**：一个线程每秒检查一次，主线程（`run_on_main_thread`）和 tokio runtime（一个先 `sleep(1ms)` 再回话的任务，连定时器一起查——#271 卡住的正是驱动定时器的那个 worker）各有一个心跳在路上，回了才发下一个。电脑睡眠时看门狗自己也停了，醒来后两次检查间隔超过 5 秒就重新计时，不算卡死。
- **应用状态**：只带现成的两样——升级状态（`update::state` 不是 idle 时的阶段，如 `restarting`）和是否已进入退出流程（`shut_down`）。
- **合并成一个事件**：同一次运行的记录在下次启动时合成一个事件，`kind` 取最能说明问题的那个——有「卡死中」= `hang`（被强制退出）；没有但有主线程上的 panic = `panic`（主线程 panic 会结束进程）；都没有 = `unclean-exit`。这次运行里别的 panic、恢复了的卡死、macOS 的报告头都作为上下文带在这个事件里。正常退出的运行里的 panic、恢复了的卡死各自单独成事件（`fatal=false`）。
- **macOS 的系统报告**：下次启动时看 `/Library/Logs/DiagnosticReports/` 和 `~/Library/Logs/DiagnosticReports/` 里上次看过以后新出现的 `codeg*.hang` / `codeg*.ips`，只取头部的几个字段（`.ips` 第一行 JSON 的 `bug_type`、`app_version`、`os_version`、`timestamp`；`.hang` 开头的 `Date/Time`、`Duration`、`Steps`、`Event`、`OS Version`、`Version`），**不上传文件本身**（里面有路径、用户名、主机名，文件名里也有主机名，所以文件名只取类型）。第一次打开开关时只记下当时的时间，之前的报告不补。读不到就算了。
- **脱敏**：消息过服务端同一套 `telemetry::scrub::scrub_text`（家目录路径、令牌、网址、邮箱），再把双引号（含中文引号）里的内容换成 `"…"`——`Debug` 打出来的字符串、文件名、会话标题多半在引号里。代码位置只留 crate 里的相对路径：依赖的 `…/.cargo/registry/src/<索引>/tokio-1.x/src/…` 只留 `tokio-1.x/src/…`，其他绝对路径只留最后三段。线程名也过一遍。

**怎么发**：启动 30 秒后（之后每 10 分钟，直到发完或退出），开关开着且有待发的事件时，按保存的远端连接的顺序问 `cowork_info`，第一个给了 `telemetry`（web 遥测 DSN）的服务器就是发送对象；一个都没有（只用本机工作区）就问 app 自带的 daemon，它用内置地址上报时就经它发（2026-11-15 起；以前不问本机）。信封里：DSN、环境、用户标识照那台服务器给的；`release` 是**出事那次运行**的桌面端版本（`dodoer-desktop@<版本>`，升级后卡死的那次和下次启动的版本不一样）；标签 `surface=desktop-native`、`kind=panic|hang|unclean-exit`、`fatal`、`os`。经那台服务器的 `/api/telemetry_envelope` 转发，用的是远端窗口代理调服务器接口的同一段代码（同一套认证、自定义请求头和重定向规则）。服务端的校验只看大小和 DSN，这种信封不用改服务端就能过。

- 发成功（Sentry 回 2xx）、或被拒收（服务端 400、Sentry 4xx）就删本地记录；没送到（网络、502、429）留着下次再试。
- 待发的最多留 5 条、7 天，超了丢最旧的。

**不做**：不传调试符号、minidump、调用栈（panic 的调用栈只在本机日志里）；不采对话内容；桌面主程序不另带 DSN（本机的上报都经自带的 daemon）。Rust 代理的连接断开另做。

#### 软件更新的记录（2026-11）

起因：macOS 桌面版改成静默升级（#412：后台下好、空闲时自己重启换上、退出过就下次启动时换上），没人盯着升级。2026-11-15 有一台 Mac 明明有「升级到 v1.6.9」的按钮却一直停在 1.6.7，原因查不到：更新出错只显示在界面上，不进日志，也不进遥测。所以每一次升级都留一条记录。说明先行：「发送诊断数据」的「会发什么」先写上「每次软件更新的结果（从哪个版本到哪个版本、成功还是失败、各步花了多久、是自动还是手动）」，上报在这之后的版本里才开始。

**记什么**：每次升级一条非致命的事件，`kind=update`。

- `level`：换上成功（`applied`）是 `info`，等了很久都没换上（`waiting_long`）是 `warning`，其余是 `error`。成功的也报：晋级稳定版要靠「抢先版的设备确认换上了新版」当证据。
- `release`：`applied` 用新版本 `dodoer-desktop@<新版本>`，其余用正在运行的版本。
- 标签：除了固定的 `surface=desktop-native`、`kind`、`fatal`、`os`，再带
  - `update_result`：`applied` / `download_failed` / `install_failed` / `boot_unconfirmed` / `waiting_long`；
  - `update_from`、`update_to`：从哪版到哪版；
  - `update_trigger`：`auto`（后台自动开始的下载）、`manual`（用户点的）、`rollback`（回退到上一版）；
  - `update_how`：怎么换上的，`idle`（空闲时自己重启）、`click`（用户点「重启以更新」）、`launch`（下次启动时换上），没到这一步就不带；
  - `install`：设备编号（`host_device::device_id`）的 SHA-256 前 12 位十六进制，用来区分设备、又不发设备编号本身。经远端 Cowork 服务器上报时用户标识是那台服务器给的用户名，两台 Mac 会是同一个，所以要这个标签。
- 上下文（`contexts.desktop`）：各步花了多久——下载（`download_ms`）、下好到开始换上（`wait_ms`）、安装（`install_ms`）、开始换上到新版本确认在跑（`boot_ms`）；包的大小（`bytes`）、是不是用了上次存在磁盘上的包（`reused_package`）、新版本启动了几次（`boots`）、空闲时自动重启被什么挡住过几次（`blocked`：本机在跑的回合、终端、借出的设备、有人在用、问不到）；失败时的错误类别（`error_kind`：网络、下载源、签名、权限、磁盘、别的）和脱敏后的报错（过 `telemetry::scrub::scrub_text`）。
- 指纹：`desktop-native` / `update` / 结果 / 错误类别（没有就是 `-`），同一种结果、同一类错误归成一个问题。

**什么时候发**：每个结果一条——新版本启动后确认在跑了（本机后端起来、主窗口建好、再过 60 秒进程还活着）报 `applied`；下载失败、安装失败、新版本启动 3 次都没确认（`boot_unconfirmed`）、下好以后 72 小时还没换上（`waiting_long`，一次升级只报一次）各报一条。下载失败只报后台自动开始的，24 小时内最多一条；用户自己点的下载失败界面上已经看得到，不报。记录放进待发以后本次运行里就发（有发送对象时 1 分钟内），不用等下次启动。

**和崩溃报告共用**：同一个开关（「发送诊断数据」，关着时只写本机日志，不记、不放待发、不发）；同一个发送通道（经连着的 Cowork 服务器或 app 自带的本机后端的 `/api/telemetry_envelope`，见上一小节「怎么发」），桌面主程序不另带上报地址。待发名额单独算：升级记录最多留 3 条，超了丢最旧的升级记录，不占崩溃报告那 5 条，谁也不挤谁。

**不记什么**：下载地址以外的网址、任何路径、用户名、设备编号本身；对话内容、代码和文件内容、终端输出照旧不碰。不报每天「在跑哪一版」。

本机日志里另有每一次状态变化（`[update] <旧状态> -> <新状态> version=<…>`），出错带错误信息，开关关着也写。

## 6. 分步

每一步一个 PR，都带测试，CI 过了才合。本机不编译 Rust，靠 CI。

1. **服务端**：`telemetry.rs`、Cargo feature、三个日志层、接口追踪、5xx / 501、转发接口、`CoworkInfo.telemetry`、环境变量。测试：脱敏用例、环境变量解析、转发接口的校验（DSN 不对、超大、没配置）、抽样名单、没配置时不初始化。
2. **前端**：`src/lib/telemetry/`、自定义传输层、接口和实时连接的埋点、`global-error.tsx`。测试：没开时入口是空操作且不加载 Sentry、脱敏用例（和 Rust 同一份）、传输层、轮询名单和 Rust 一致。
3. **对话收尾和反馈**：一轮对话的 span、兜底收尾的警告、「反馈问题」入口。
4. **发版、接到生产**（要用户点头）：发 cowork-codeg 新版本 → Cowork 跟版 → 生产机写 `telemetry.env`、重启服务。先在 AI QA 的环境里跑通第 7 节的验收，再上生产。
5. **发版流程**：上传源码映射、在 Sentry 里登记版本；Cowork 仓库的心跳、账户页说明、AI QA 接入。
6. **每周汇总**：读 Sentry 的接口，把新问题、失败最多的接口、断连时长、兜底收尾次数汇成一个 issue。

前三步写完大约两到三天，主要耗在等 CI 编 Rust。

## 7. 验收

1. **没有地址就关**：本地编的（没有内置地址）不配环境变量起服务，`cowork_info` 里没有 `telemetry`，浏览器没有请求遥测的 chunk，没有 `telemetry_envelope` 调用；发版的包带 `CODEG_TELEMETRY=off` 起服务也一样。发版的包什么都不配，启动日志写 `on (built in)`，Sentry 里出现 environment `community`、用户是 12 位编号的记录。
2. **服务端**：配上之后启动时带 `CODEG_TELEMETRY_SELFTEST=1` 打一条测试 ERROR，一分钟内出现在 Sentry 的服务端项目里，带版本、环境、用户。
3. **前端**：浏览器控制台调自检函数，前端项目里出现一条错误，没有 IP。
4. **两头串起来**：发一条消息，`acp_prompt` 在 Sentry 里是一条追踪，里面有浏览器的 span 和服务器的事务，两者之差就是网络耗时。
5. **断网**：开发者工具里断网 10 秒再恢复，出现一条约 10 秒的断连 span，带关闭码；断网期间的记录在恢复后补发。
6. **接口 500**：让一个接口返回 500（测试里构造），Sentry 里按命令归成一个问题。
7. **不漏内容**：在一个名字带暗号的项目里发一条带暗号的消息，跑一轮对话、制造一次报错，然后在 Sentry 里搜这两个暗号，都搜不到。
8. **用量**：正常使用一小时，span 数量在估算范围内，没有轮询接口刷屏。

## 8. 局限

- 免费档只有一个登录账号，数据留 30 天。
- 服务器挂了的那段时间，前端的记录要等恢复后才补发；这期间只有心跳告警。
- 只能分出「浏览器到服务器」和「服务器内部」两段，分不出中间哪一跳慢。
- 服务端错误没有调用栈；前端在上传源码映射之前堆栈是压缩的。
- 手机 App 没覆盖；桌面端内嵌 daemon 模式下本机后端不报。
- 内置地址是公开的（第 10 节「默认开」）：谁都能往这两个项目里灌数据。
- 回答不了「哪里难用」，那要靠人的反馈和以后的行为分析。

## 9. 放弃或推后的方案

- **Datadog / New Relic / Grafana Cloud**：Datadog 没有免费档，按主机和功能分项收费，还要在服务器上装常驻的采集程序；New Relic 多一个完整账号很贵；Grafana 额度大方但仪表盘要自己搭、报错归类弱。
- **浏览器直连 Sentry**：会被广告拦截插件拦掉，跨境网络不稳，上报地址暴露在页面里。**nginx 转发**：要改 Cowork 仓库的 nginx 模板、多一处配置，桌面端的远端窗口还得另想办法。
- **`@sentry/nextjs`**：它的价值在服务端渲染和构建插件，静态导出用不上；而且会让所有用户一上来就加载 SDK。
- **Sentry 自带的 tower 中间件 + `SpanLayer` 自动追踪**：现有的长寿命 span 会变成几小时的追踪，字段带路径；轮询接口也没法单独抽样。
- **先上 OpenTelemetry 再转给各家**：要在服务器上多跑一个转发程序。以后真要换平台，改的也只是 `telemetry.rs` 和 `sentry.ts` 两个文件。
- **录屏**：屏幕上全是对话和代码，全遮了又没什么可看；免费档只有 50 段。等接行为分析时再议。
- **从外面定时探测服务器**：推后。部署上如果限制了来源地址，探测进不来；心跳加浏览器那头的数据已经够用。

## 10. 实现时改了的地方

### 第 1 步（服务端）

- **依赖**：只用 `sentry-core` 和 `sentry-tracing`（都关掉默认 feature），不用 `sentry` 这个总包。总包的默认集成（panic、上下文、调用栈）本来就不要，它的传输层要 reqwest 0.13，会再带一套 HTTP/TLS。发送自己写：一个线程、一个有界队列、仓库已有的 reqwest 0.12。
- **初始化分两处**：读环境变量并删掉放在 `cowork::init_process_env`（那里是唯一保证单线程、最先读环境的地方）；建客户端放在日志建好之后（它要打日志），仍在 tokio runtime 之前。日志层先装上，客户端没建好之前什么都不做。
- **轮询名单不放共享的 JSON 文件**：Docker 构建的前后端两段各只拷自己的目录，跨目录读文件会让其中一段编不过。名单只在 Rust 里（`config::POLLED_COMMANDS`），经 `cowork_info.telemetry.commandSampleRates` 告诉前端。脱敏用例只有测试读，放在 `src/lib/telemetry/scrub-cases.json`，Rust 测试用 `include_str!` 读它。
- **`trace_request` 的签名**：多传 `request_id` 和「后面的处理」（一个闭包），因为 `request_id` 是现有中间件生成的。
- **限速**：Sentry 回的限速头按最长的那个整体暂停，不分类别。

### 第 2 步（前端）

- **入口的函数**：`startTelemetry` / `reportError` / `beginApiCall` / `noteWs` / `installEarlyCapture`。`turnStarted` / `turnSettled` / `sendFeedback` 留到第 3 步。
- **信封怎么带上 DSN**：SDK 只在设了 `tunnel` 时把 DSN 写进信封头，所以设了 `tunnel`，但传输层不用这个地址，直接走 `telemetry_envelope` 接口。服务端拒收（404 / 400）当成发完了，不重试；没送到、或者服务端连不上 Sentry（502），才留在离线缓存里重发。
- **启动的触发点**：`TelemetryInit` 只读已经缓存的 `cowork_info`，自己不去要。账户菜单和更新检查会加载它；在登录页要只会拿到 401。
- **桌面端远端窗口**：代理只回错误不回状态，接口结果按错误码推（`network_error` 算网络失败，服务端映射成 5xx 的那几个码算 500，`not_implemented` 算 501）。
- **追踪**：每次接口调用单独开一条追踪（页面不跳转，挂在页面加载下面的话那条追踪永远不结束）。只开页面加载的追踪，不开路由跳转、INP、长任务。SDK 11 默认把 span 流式发送，转发接口不用区分。
- **用量**：日志每页每分钟最多 120 条，错误每页 30 条、相同的 60 秒一次。

### 第 3 步（对话收尾和反馈）

- **没有 `turnSettled`**：`turnStarted(agent)` 返回一个句柄（`noteEvent` / `end`），挂在面板记着「最后发出的消息」的 `lastSentRef` 上，它被清掉的地方就是一轮结束的地方。结果分七种：正常收尾、以错误结束、兜底收尾、服务端说已有一轮在跑（回了队列）、发送失败、被下一次发送顶掉、面板先关了。只记这个标签页自己发出的轮次。
- **「多久收到第一个事件」分成两个数**：第一个事件（不算对发送的回声 `user_message` / `user_prompt_sent`）和第一段回复（`content_delta`、`thinking`、`tool_call` 等）。另记收到的事件总数。
- **兜底收尾的警告**用固定指纹 `stranded-turn` 归成一个问题，多带这一轮收到的前 20 个事件类型。轮次的 span 按 `tracesSampleRate` 抽样，警告和失败日志不抽样。
- **反馈**：`captureFeedback` 不走 `beforeSend`，脱敏挂在 scope 的事件处理器上；文字过同一套规则，上限 4000 字。菜单项在遥测真正启动后才出现，桌面端远端窗口里也有。
- **远端窗口没有实时连接的数**：那里事件走桌面端自己的连接，断开次数是 0、状态是 `none`。

### 桌面端自己的进程（第 5.11 节，2026-11-15）

- **代码在 `src-tauri/src/crash_report/`**，只在桌面端（`tauri-runtime`）编译，服务端和 CLI 不带。不用 Sentry 的 SDK：事件和信封自己拼（`envelope.rs`），桌面端本来就不链接 `sentry-core`。
- **钩子和看门狗总是装着**，开关只控制写不写文件、发不发。这样在设置里打开就立刻生效，不用重启；关着时一个睡着的线程的开销可以忽略。
- **panic 钩子里不做脱敏**：钩子里只写原始消息（截到 2 KB）和位置，脱敏在下次启动合成事件时做。钩子里少跑正则就少一个出错的机会，原始记录只在用户自己的电脑上、开关开着时才有。
- **单引号里的内容不去掉**：英文里单引号多半是撇号（`can't`），Rust 自己的消息（`thread 'main'`）也用它；只去双引号和中文引号里的。
- **记录在 setup 里才开始写**：单实例插件在 setup 之前就让第二个实例退出了，在 `run()` 开头写的话，第二个实例会把正在运行的那个当成「上次没正常退出」。

### 默认开（2026-11-15）

用户决定：服务端、网页、桌面端崩溃和卡死、本机工作区全部默认开，可以关（第 2、5.1、5.11 节）。

- **怎么开的**：上报地址编进发行的 `codeg-server`（`option_env!("CODEG_TELEMETRY_BUILTIN_DSN")` / `_WEB_DSN`，空字符串当没有），环境变量优先。前端不内置，照旧从 `cowork_info` 拿；桌面主程序不内置，本机的上报都经它带着的 `codeg-server` 子进程。
- **生产机不变**：`/etc/cowork/telemetry.env` 两个地址都配了，按第 5.1 节第 2 条用环境变量的，environment 和用户标识的默认值也照旧（`production`、登录名）。
- **一半配了另一半没配就不掺内置的**（第 5.1 节第 4 条）：配了自己 Sentry 的部署（AI QA、以后别的团队），没配的那一半不会悄悄报到我们的项目里。
- **桌面端的开关**从「崩溃和卡死报告」改成总开关「发送诊断数据」，偏好换了个键（`diagnostics`，三态：没有 = 开）。旧键 `crash_reports` 不读：它默认 `false`，分不出是不是用户关的；#290 才发了一天，按「没设过」处理。
- **运行中切换**：崩溃报告立刻生效；本机后端和本机窗口下次启动 dodoer 才生效（子进程的环境在启动时定）。没做成重启子进程：重启会打断正在跑的对话，为一个开关不值得。
- **代价：地址等于公开。** 编进公开发行的程序里，谁解包都能拿到，可以往这两个 Sentry 项目里灌假数据、刷掉免费额度。兜底：转发接口自己的额度（每进程每分钟 60 个信封、带报错的另 30 个，第 5.4 节）只管经我们服务器转发的那部分，直接拿地址往 Sentry 发的拦不住；所以还要靠 Sentry 自己的项目限额。前端那个地址本来就会经 `cowork_info` 给到浏览器，服务端那个地址以前只在生产机上。要是被滥用了，换一个地址（Sentry 里给项目新建 Client Key、停掉旧的，改 secret、发一版），旧版本的包就报不进来了。
- **待办（要人在 Sentry 后台做）**：两个项目（服务端、前端）都打开 Spike Protection；在 Client Keys 里给内置的那两个 key 设速率限制（比如每分钟几百条）；确认「不存 IP」和数据清洗（第 5.7 节）在两个项目里都开着；Inbound Filters 按 environment 看一下 `community` / `desktop-local` 的量，必要时单独限。生产机用的 key 最好和内置的分开（各一个 Client Key），被刷的时候只停内置那个。
- **放弃的方案**：
  - 地址放在前端包里、网页直连 Sentry：广告拦截和跨境网络照样拦（第 9 节），地址照样公开。
  - 自己架一个转发服务、包里只带它的地址：多一个常驻服务要运维，转发服务的地址同样公开，只是多了一层限速；量起来了再考虑。
  - 每个安装先找我们注册拿令牌：要账号体系，第三方的服务器也得能连到我们，太重。
  - 用户标识沿用系统用户名：别人机器上的用户名是个人信息；用主机名也一样。
  - 所有构建都内置地址（含 PR、qa）：每次 CI、冒烟都会往生产的项目里报，数据脏；PR 产物也没必要带。

### 软件更新的记录（2026-11）

- **说明先行**：#412 拆成几步、每一步合了都会自动发版。第一步只改「发送诊断数据」的「会发什么」（10 个语言）和本文档第 5.11 节「软件更新的记录」，上报在后面的步骤里才做，先让说明到用户手里。「不会发什么」不变：升级记录不带路径、下载地址以外的网址和用户名。
- **不另开开关**：升级记录跟着「发送诊断数据」走，不单独加一个「发送更新记录」。它和崩溃报告是同一类东西（桌面端自己出了什么事），分开开关只会让人以为关了一个就都不发了。
- **待发名额分开**：升级记录 3 条、崩溃报告 5 条，各算各的。成功的升级也报，混在一起算的话，一天多次升级会把还没发出去的崩溃报告挤掉。
