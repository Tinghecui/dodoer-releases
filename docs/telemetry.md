# 遥测：看清「哪里坏了、是谁的问题」

状态：第 1 步（服务端，`src-tauri/src/telemetry/`）、第 2 步（前端，`src/lib/telemetry/`）、第 3 步（对话收尾和「反馈问题」）已写，都还没发版。实现和下面方案不一样的地方记在第 10 节。

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

- **默认关。** 不配置就不采、不连外网、连遥测的前端代码都不加载。公开安装包里不带任何上报地址。
- **不采内容。** 对话、代码、文件内容、终端输出、文件路径一律不上报（第 5.7 节）。
- **不在服务器上装常驻的采集程序。** 生产机内存紧，上报嵌在 codeg-server 进程里。
- **费用封顶。** 用量有上限，超了就丢，不会多花钱（第 5.8 节）。

不做：

- 用户行为分析（哪些功能没人用、哪一步放弃）和录屏。那是另一类工具（PostHog）的事，等有了多个真实用户再接；前端留了统一的入口，到时不用再改各处调用。
- 机器指标（CPU、内存、磁盘）的长期曲线。侧栏的资源表已经能看当前值。
- 桌面端自己的进程（Tauri 的 Rust 那一半）和手机 App。第一版只管服务器和网页前端；桌面端的远端窗口跑的是同一份前端，自动带上（第 5.11 节）。

## 3. 一句话方案

用 Sentry。codeg-server 进程内直接上报服务端的错误、接口耗时和连接日志；前端的遥测不直接连 Sentry，而是走 codeg 自己的接口，由 codeg-server 转发出去。开关和上报地址只来自服务器的环境变量，前端从 `cowork_info` 得知要不要开。

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

只有环境变量，和 Cowork 现有的做法一致（`COWORK_<X>` 是 `CODEG_<X>` 的别名）。读完从进程环境里删掉，agent、终端这些子进程看不到。

| 变量 | 作用 |
|---|---|
| `CODEG_TELEMETRY_DSN` | 服务端项目的上报地址。不设：服务端遥测整个关掉，Sentry 客户端不初始化。 |
| `CODEG_TELEMETRY_WEB_DSN` | 前端项目的上报地址。不设：`cowork_info` 里没有遥测配置，前端不加载遥测代码，转发接口回 404。 |
| `CODEG_TELEMETRY_ENV` | 环境名，默认 `production`。AI QA 的环境设 `ai-qa`，两边的数据分开看。 |
| `CODEG_TELEMETRY_TRACES` | 接口追踪的抽样率，0 到 1，默认 1。量大了往下调。 |
| `CODEG_TELEMETRY_USER` | 这个进程的用户标识。默认是系统用户名去掉 `cw-` 前缀。 |

`CoworkInfo` 多一个可空的字段，前端据此决定开不开：

```jsonc
"telemetry": {
  "dsn": "…",              // CODEG_TELEMETRY_WEB_DSN
  "environment": "production",
  "release": "cowork-codeg-v0.6.0",   // 服务端读 COWORK-VERSION
  "tracesSampleRate": 1,
  "user": "james"
}
```

上游服务器没有 `cowork_info`，本机的桌面工作区不问 `cowork_info`，两种情况下前端的遥测都保持关闭，行为和现在完全一样。

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
- 轮询接口（第 4 节那三个，加 `get_system_resources`、`health`）按 1% 抽样；`telemetry_envelope` 自己不追踪。名单放在一个 JSON 文件里，Rust 和前端各自读它，保证两边一致。
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

服务端的转发做四件事：没配 `CODEG_TELEMETRY_WEB_DSN` 回 404；信封头里的 DSN 必须等于配置的那个，否则 400（不当开放代理）；单个信封最大 256 KB，进程内每分钟最多 60 个，超了回 429；把 Sentry 回的限速头原样带回前端，SDK 自己会退避。

断网时前端发不出去：传输层外面包一层离线缓存（存在 IndexedDB），恢复后补发。所以「断网那一刻发生了什么」不会丢。

### 5.5 采哪些信号

| 信号 | 来源 | 在 Sentry 里是什么 | 回答什么 |
|---|---|---|---|
| 前端报错、渲染崩溃 | 浏览器 | 错误 | 哪里坏了 |
| 服务端 ERROR、panic | 服务器 | 错误 | 哪里坏了 |
| 接口 5xx | 服务器 | 错误，按命令归类 | 哪里坏了 |
| 接口耗时（两头） | 浏览器 + 服务器，同一条追踪 | 追踪 | 慢在网络还是服务端 |
| 接口超时、网络失败、501 | 浏览器 | 日志 | 网络问题、版本不匹配 |
| 实时连接断开和恢复 | 浏览器 + 服务器 | 日志 + span | 谁断的、断了多久 |
| 一轮对话的收尾方式 | 浏览器 | span；兜底收尾另报警告 | #172 这类状态问题 |
| 页面加载性能 | 浏览器 | 追踪 | 首屏慢不慢 |
| 用户反馈 | 浏览器 | 反馈 | 哪里难用（人说的） |

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

- 远端窗口：跑的是同一份前端，问的是它连的那台服务器的 `cowork_info`，上报经 Rust 代理走同一个转发接口。等桌面端发了带这份代码的版本就自动生效。追踪头暂时带不过去（代理自己组请求头），两头的记录靠时间和 request_id 对。
- 本机工作区：不问 `cowork_info`，遥测不开。
- 桌面端自己的进程（崩溃、Rust 代理的连接断开）：后面再做，那是用户自己的电脑，要在设置里单独征得同意。

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

1. **默认关**：不配环境变量起服务，`cowork_info` 里没有 `telemetry`，浏览器没有请求遥测的 chunk，没有 `telemetry_envelope` 调用。
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
- 桌面端进程、手机 App 没覆盖。
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
