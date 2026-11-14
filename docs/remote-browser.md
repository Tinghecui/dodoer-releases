# 远端智能体借用桌面 app 的内置浏览器

状态：已实现（第 7 节列了各步的 PR）。改动清单见 `COWORK.md`「远端智能体借用桌面 app 的内置浏览器」。

## 1. 问题

智能体跑在 codeg-server 上，用户用桌面 app 的远端窗口连过去。远端窗口右侧能开网页标签，但这些标签是桌面 app 本机的原生 webview，服务器碰不到。所以服务器从不给智能体注入 `browser_*` 工具：`acp/connection.rs` 里注入的条件是 `cfg!(feature = "tauri-runtime")`，codeg-server 编译时这个常量是假的。

这个门还挡住了另一种情况。daemon/client 拆分第 2 步之后，桌面 app 的本机工作区也跑在子进程 codeg-server 里（`local_daemon.rs`）。子进程已经能通过 host bridge（`host_bridge.rs`）用 app 的浏览器，`codeg_server.rs` 也把 `HostBridgeClient` 接成了 `BrowserToolAccess`，但注入时同样卡在这个 `cfg!` 上。结果是**本机工作区的智能体现在也拿不到浏览器工具**。电脑操作走的是运行时标记 `is_served()`，不受影响。

## 2. 目标

- 远端窗口里，智能体调用 `browser_*` 时，服务器把调用转给这个窗口所在的桌面 app。app 在用户眼前的标签上执行，再把结果传回服务器。
- 页面、登录态、授权按钮、执行代码前的确认弹窗都在桌面端，和本机工作区的体验完全一样。
- 顺带让本机工作区（子进程 daemon）重新拿到浏览器工具。

不做：

- 服务器自己起无头浏览器：吃内存，而且不是用户看到的页面。
- 转发电脑操作（`computer_*`）：这等于远程控制用户的电脑，风险高一个量级，另案再议。
- 网页版：网页版里的标签是浏览器自己渲染的 iframe，任何一端都读不到。
- 用户自己的 Chrome：将来做成扩展，作为第三种标签来源接到同一个 `BrowserToolAccess` 上，见第 8 节。

## 3. 现有可以复用的部分

| 部分 | 位置 | 本方案里怎么用 |
|---|---|---|
| `BrowserToolAccess` trait | `acp/browser_tools.rs` | 服务器端新加一个实现：通过 WS 转发 |
| 调用的 wire 格式 `BridgeCall` / `BrowserCall` | `host_bridge.rs` | 原样作为 WS 消息的载荷，不另外定义 |
| 桌面端执行器 `host_bridge::dispatch(&HostTools, call)` | `host_bridge.rs` | 桌面端收到调用后直接调它 |
| 桌面端浏览器工具 `McpBrowserTools` | `commands/browser.rs` | 加一个按窗口限定范围的构造方式 |
| 每页授权（none / read / control）、eval 确认、冷却 | `browser/agent.rs`、`browser/confirm.rs`、`commands/browser.rs` 的 `*_core` | 都在执行端检查。转发以后照样生效，不用改 |
| 桌面端到服务器的长连接 `/ws/events` | 桌面端 `commands/remote_proxy.rs`（Rust 读循环）；服务器 `web/ws.rs`、`web/ws_attach.rs` | 加几种消息，承载反向调用 |
| 能力声明 `server_info.features` | `compat.rs` | 加一个 feature 名，桌面端看到它才注册 |

关键一点：授权和确认本来就在执行端做。执行端是桌面 app，安全边界就不用重做。

## 4. 协议

所有新消息走现有的 `/ws/events`。客户端发的消息用 `action` 标签（`ClientMsg`），服务器发的用 `type` 标签（`ServerMsg`），和现有消息一致。

### 4.1 能力声明与注册

1. 服务器在 `compat::FEATURES` 里加上 `"host_bridge_ws"`。窗口每次连上都会发 `hello`，服务器回的 `server_info` 里就带着它。
2. 桌面端的 **Rust 读循环**（不是网页层）看到 `server_info` 里有 `host_bridge_ws`，就在同一条 socket 上发：

   ```json
   {"action": "host_register", "capabilities": ["browser"], "window": "remote-workspace-3"}
   ```

   `capabilities` 按桌面端**本机**的浏览器工具开关决定：开关关着就报空列表，服务器不会选它。本机开关一改，app 就向所有借出的服务器重新发一次 `host_register`。
3. 服务器把这条 socket 登记进 `HostRegistry`（新模块 `web/host_registry.rs`），由服务器分配 `host_id`。socket 断开就注销。重连后会再收到 `server_info`，于是重新注册，不用另外处理。
4. 老服务器没有这个 feature，桌面端就不注册，什么都不变。老客户端和网页版不发 `host_register`，也什么都不变。
5. 本机 daemon（连接 id `-1`）跳过注册，它已经有 HTTP 的 host bridge。

### 4.2 反向调用

```json
// 服务器 → 桌面
{"type": "host_call", "call_id": 7, "call": {"tool": "browser", "call": {"method": "snapshot", "args": {"tab_id": "t1", "max_chars": null}}}}
// 桌面 → 服务器
{"action": "host_result", "call_id": 7, "outcome": { ... }}
```

`call` 就是 `host_bridge::BridgeCall` 的 JSON，`outcome` 就是 `dispatch()` 的返回值。v1 只转发 `tool: "browser"`。如果服务器发来 `computer`，桌面端回 `NoComputerDesktop` 的答案。

服务器端的 `RemoteHostBrowser` 实现 `BrowserToolAccess`，每个方法的步骤：

1. 选一个 host（4.4）；
2. 分配 `call_id`，在待答表里放一个 oneshot；
3. 发出 `host_call`；
4. 等结果。

各种失败都和 `HostBridgeClient` 一样，退回 `NoBrowserTabs` 的答案，只是把 note 换成「请在 dodoer 桌面 app 里打开这个工作区，并共享要用的标签」。

超时设置：

- 普通调用：60 s。`tab_op` 要等页面加载。
- `eval`：150 s。桌面端的确认弹窗自己有 120 s 超时，外层要比它长。
- socket 断开时，待答表里所有的调用立即失败。

### 4.3 桌面端执行

收到 `host_call` 后，在 Rust 里直接 `host_bridge::dispatch(&tools, call)`，结果发回服务器。不经过网页层，所以窗口最小化也照常工作。每个调用单独 spawn 一个任务，不阻塞读循环（eval 可能要等用户 2 分钟）。

`tools.browser` 是一个**限定在这个窗口**的 `McpBrowserTools`：

- `list_tabs` 只列 `owner_window == "remote-workspace-{id}"` 的标签；
- 其他调用先检查 `tab_id` 是否属于这个窗口，不属于就当作不存在（`browser_no_such_tab`）；
- `tab_op Open` 在这个窗口里开标签。

这样一台电脑同时连两个服务器时，A 的智能体看不到 B 窗口的标签，也看不到本机工作区的标签。

开关以桌面端本机的设置为准（`McpBrowserTools` 本来就读它）。理由是浏览器在谁的电脑上，开关就归谁，服务器不能替人打开别人电脑上的 eval。为了不让人开两次，远端窗口的 MCP 弹层里**打开**浏览器开关时，会同时打开本机的开关；**关闭**只关服务器的，本机工作区的设置不受影响（服务器开关关了就不会有调用过来）。

### 4.4 选哪个 host

同一个员工可能同时开着两台电脑：

1. 选最近获得焦点的那个窗口：桌面端在窗口获得焦点时发 `{"action": "host_focus"}`；
2. 一次焦点事件都没有时，选最近注册的；
3. 不广播，也不同时问多个 host。

## 5. 注入的条件

companion 的 feature 在智能体启动时就定死了（`companion_features_arg`），运行中不能再加工具。决定是：

- 把 `cfg!(feature = "tauri-runtime")` 换成运行时标记 `BrowserToolsRuntimeConfig::is_served()`，和电脑操作的 `ComputerToolsRuntimeConfig::is_served()` 对称。
- 桌面 app（内嵌模式）启动时标记 served。
- codeg-server 有本机 host bridge 时标记 served（这样修好了第 1 节说的本机工作区缺口）。
- codeg-server 打开反向通道之后，**一直**标记 served。也就是说只要服务器上的浏览器工具开关是开的就注入，调用时如果没有 host，再告诉智能体去请用户打开桌面窗口。

没有选「启动时有 host 才注入」：用户先开会话、再打开桌面窗口的话，这个会话就永远拿不到工具，只能新开会话，很难解释。浏览器工具开关默认是关的，没开的人不会多出这些工具占上下文。

## 6. 安全

- **授权在执行端**：每页共享和 eval 确认都在桌面端。服务器端新加的只有转发，没有任何「替用户同意」的路径。
- **共享级别和本机一样**：远端窗口里网页工具栏的「共享给智能体」按钮原来是禁用的（`browser-agent-access.tsx`），现在放开。浏览器设置里的「默认共享级别」（出厂是「控制」）也照本机一样套到远端窗口的每个网页上；设成「不共享」时，用户点了才共享。离开这个域名就按新域名重新套用或收回。（第 4 步只放开了按钮，漏了默认级别，远端窗口要逐页手动共享，2026-11-14 补上。）
- **一条连接只看到自己窗口的标签**，见 4.3。
- **谁能注册成 host**：拿着这台服务器 token 的任何客户端都能注册。token 本来就是这个员工自己的。冒充的 host 最多能给智能体喂假的页面内容，拿不到任何新权限。真正的设备身份要等拆分计划第 4 步（钥匙串和设备列表）。
- **结果大小**：截图（`BrowserCaptureOutcome`）走 base64 文本帧，要确认 `/ws/events` 的帧大小上限够用，不够就在桌面端缩图。

## 7. 分步落地

每一步一个 PR，可以单独合并、单独回滚。Rust 只在 CI 上编译和测试。

1. **注入门改成运行时标记**。新增 `BrowserToolsRuntimeConfig::mark_served / is_served`；桌面内嵌模式和「有本机 host bridge 的 codeg-server」标记 served。单独合并就能修好本机工作区拿不到浏览器工具的问题。
2. **服务器端反向通道**。`HostRegistry`；`ClientMsg::HostRegister / HostResult / HostFocus`；`ServerMsg::HostCall`；`RemoteHostBrowser`；`compat::FEATURES` 加 `host_bridge_ws`；`codeg_server.rs` 没有本机 bridge 时改用 `RemoteHostBrowser`，并标记 served。单元测试用假 host 跑往返、超时、断开。
3. **桌面端处理**。`remote_proxy.rs` 读循环识别 `server_info` → 注册，识别 `host_call` → spawn `dispatch` → 回 `host_result`；`McpBrowserTools` 加窗口范围；窗口获得焦点时发 `host_focus`。
4. **前端**。放开远端窗口里的共享按钮，改掉「远程工作区无法使用这台电脑的浏览器」的提示；MCP 弹层里「查看和操作桌面窗口」在服务器没有提供电脑操作时置灰，并注明只能在本机工作区用。
5. **收尾**。`COWORK.md` 改动清单，本文档按实现更新。

对应的 PR（Tinghecui/cowork-codeg，依次叠在前一个上）：设计 #65，第 1 步 #66，第 2 步 #67，第 3 步 #76，第 4 步 #81，第 5 步见本文档所在的 PR。

实现时多做的两件事：

- 第 4 步顺带修了本机 daemon 模式下 MCP 弹层的开关不生效：弹层的 `set_codeg_mcp_tool_group` 原来只发给子进程，而浏览器和电脑操作由 app 提供、读 app 自己那份开关。现在两边都发（`BOTH_COMMANDS`）。
- 工具组状态多了 `served` 字段，服务器上没有电脑操作时弹层置灰并写明「只能在本机工作区里用」。

## 8. 以后：用户自己的 Chrome

方案见 `docs/agent-chrome.md`（2026-11-14 用户定的方向：接管日常用的那个 Chrome）。要点：

- Chrome 136 起不允许用启动参数在默认数据目录上开调试端口或管道，所以不走那条路。
- Chrome 144 起有官方入口：用户在 `chrome://inspect/#remote-debugging` 打开开关，外部程序连接时 Chrome 弹窗让用户允许。dodoer 走这个入口，标签作为第三种 surface 进同一个注册表，再经本文档的通道借给服务器。
- 这个入口在用户的机器上连不上时，退路是 Chrome 扩展：页面侧复用 `browser-agent/` 的快照和动作脚本作为 content script，扩展和 dodoer 之间走 Native Messaging，不开本地端口。

## 9. 验收

在桌面 app 的远端窗口里：

1. 右侧打开一个需要登录的网页，登录。
2. 不共享，让智能体调用 `browser_list_tabs`：能看到这个标签。再调用 `browser_snapshot`：返回 `browser_grant_required`。
3. 点「共享给智能体」，选「读取」：`snapshot` 返回登录后的页面内容。
4. 改成「控制」并打开 eval：智能体执行一段 JS，电脑上弹出确认框。点允许，拿到结果；点拒绝，返回 `browser_eval_declined`。
5. 关掉远端窗口再调用：返回没有标签，note 里让用户打开桌面窗口。
6. 同一台电脑打开一个本机工作区的标签：服务器上的智能体看不到它。
7. 本机工作区（子进程 daemon）里：智能体拿到 `browser_*` 工具，能读共享的标签（第 1 步的回归验证）。

## 10. 已知局限

- 服务器选 host 只看「最近注册或获得焦点」。同一个人在两台电脑上同时开着同一个工作区时，调用会去最近点过的那台。
- 桌面 app 的开关从别处改（配置导入、直接改数据库）不会触发重新注册，要等下次重连。
- 截图结果走 WS 文本帧（base64）。axum 和 tungstenite 默认的消息上限都是 64 MiB，够用，没有另外缩图。
