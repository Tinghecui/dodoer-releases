# 智能体接管用户日常用的 Chrome

状态：方向已定（2026-11-14，用户）；第 10 节的真机实测做了三轮，这条路走得通。第 1 步（连接）已写，见第 7 节；Chrome 的标签还没接进来，智能体还用不了。

## 1. 问题

智能体现在能用的浏览器只有 dodoer 的内置浏览器（本机工作区直接用，服务器上的智能体经 `docs/remote-browser.md` 的通道借用）。用户的目标是让智能体自动填表、填信息、把事情做完，内置浏览器离这个目标差三件事：

- **登录状态要重新来一遍**。用户的账户都登在日常用的 Chrome 里，内置浏览器是另一套 Cookie。
- **人不好接手**。登录、验证码、付款确认这些要人来做的步骤，用户习惯在自己的 Chrome 里做；智能体干到一半，人接一下，再交回去，最好就在同一个浏览器里。
- **macOS 上没有真输入**。`BrowserSurface::supports_trusted_input` 只在 Windows（WebView2）上为真；WKWebView 上点击是脚本派发的事件（`isTrusted` 为假），有的表单和风控不认。

用户定的方向（2026-11-14）：让智能体接管用户日常用的那个 Chrome（默认数据目录、默认用户）。之前写的「另开一个单独数据目录的 AI Chrome」先不做，见第 12 节。

## 2. 目标

- dodoer 桌面 app 连上用户正在用的 Google Chrome，用 Chrome DevTools Protocol（CDP）驱动它。
- Chrome 的标签和内置浏览器的标签出现在同一套 `browser_*` 工具里：`browser_list_tabs` 里标明来源，读、点、输入、截图、控制台都照旧。智能体不用学新工具。
- 人随时能接手：智能体的页面就开在用户的 Chrome 里；用户自己开的页面也能交给智能体接着做；一个开关能让智能体立刻停手。
- 服务器上的智能体经现有的借浏览器通道（`/ws/events`、`host_bridge_ws`）同样能用。**服务器不用升级**：协议和工具定义都不变，改动全在桌面端。

不做：

- 替用户打开 Chrome 的远程调试开关，或绕过 Chrome 的允许弹窗。这两步都必须是用户自己做的。
- 无头模式、dodoer 自带浏览器。
- Windows、Linux。第一版只做 macOS（现在只发 macOS 的桌面包）。
- 文件上传、下载的专门工具。内置浏览器现在也没有，以后一起做。

## 3. 一句话方案

Chrome 144 起，用户在 `chrome://inspect/#remote-debugging` 打开开关后，外部程序可以连上正在运行的 Chrome，每次连接 Chrome 弹窗问用户是否允许。dodoer 走这条官方入口连上去。Chrome 的每个标签在 dodoer 里是 **第三种 surface**：和内嵌 webview（`Child`）、独立窗口（`Window`）并列，登记在同一个 `BrowserRegistry` 里。这样共享级别、每次读写前的检查、活动记录，全部走现有的 `agent_*_core`，不另写一套。

```
智能体（本机，或服务器经 /ws/events）
   │  browser_* 工具，不变
   ▼
McpBrowserTools ──► BrowserRegistry ──► BrowserSurface
                                          ├─ Child    内嵌 webview（现有）
                                          ├─ Window   独立窗口（现有）
                                          └─ External 用户 Chrome 的一个标签（新）
                                                │ CDP，WebSocket，127.0.0.1
                                                ▼
                               用户正在用的 Google Chrome（用户开了开关、点了允许）
```

## 4. 现有可以复用的部分

| 部分 | 位置 | 怎么用 |
|---|---|---|
| 页面侧脚本（Playwright aria 树、ref、点击 / 输入 / 选择） | `browser-agent/` → `src-tauri/src/browser/js/agent.bundle.js` | 原样用。`pnpm browser:agent:probe` 本来就是在真 Chrome 里经 CDP 跑它 |
| 共享级别、检查、活动记录 | `browser/agent.rs`、`commands/browser.rs` 的 `agent_snapshot_core` / `agent_act_core` 等 | 不改，surface 换了它们不知道 |
| 页面离开共享的域名就收回 | `browser/hooks.rs` | Chrome 的导航事件喂给同一组函数 |
| 真输入的入口 | `BrowserSurface::dispatch_pointer`（现在只有 WebView2 接了，也是 CDP `Input.*`） | Chrome 接同一个入口，macOS 上第一次有真点击 |
| 站点规则的判断 | `browser/policy.rs` | 判断函数复用；Chrome 用自己的一张名单（见 5.5） |
| 借给远端 | `commands/remote_proxy.rs` 的 `DesktopWsHost`、`McpBrowserTools::scoped` | 只改「这个范围看得到哪些标签」一条规则 |
| WebSocket 库 | `tokio-tungstenite`（已在 `Cargo.toml`） | 不加新依赖，CDP 客户端自己写（JSON-RPC，几百行） |

## 5. 设计

### 5.1 连上 Chrome

- **用户做两件事**：在 Chrome 里打开 `chrome://inspect/#remote-debugging` 的开关（一次）；dodoer 连上来时在 Chrome 的弹窗里点「允许」。dodoer 的设置页写清这两步，并给一个「连接 Chrome」按钮；点了之后提示「请到 Chrome 里点允许」。
- **怎么找到它**：开关打开后 Chrome 在数据目录写 `DevToolsActivePort`（macOS：`~/Library/Application Support/Google/Chrome/DevToolsActivePort`），第一行是端口，第二行是浏览器端点的路径。dodoer 读它，连 `ws://127.0.0.1:<端口><路径>`。**只读，不删、不改这个文件**（有别的工具在等用户点允许时超时就删它，把正常的 Chrome 弄坏过）。
- **macOS 还有一道权限**：macOS 27 起，别的 app 读不了 Chrome 的数据目录（实测 `cat` 这个文件回 `Operation not permitted`，系统不弹窗问，直接拒绝）。所以 dodoer 读 `DevToolsActivePort` 之前，用户要在「系统设置 → 隐私与安全性 → 文件与文件夹」里给 dodoer 打开「Google Chrome」。dodoer 读到 `EPERM` 时说的是「macOS 不让读」并给出去系统设置的按钮，不能说成「Chrome 没开开关」（上游工具就是把这两种情况混成一句，害人查错方向）。
- **权限给不上时的手动办法**：Chrome 自己读得了这个文件。设置页里留一个输入框：用户在 Chrome 里打开 `file:///Users/<用户>/Library/Application Support/Google/Chrome/DevToolsActivePort`，把第二行（`/devtools/browser/…`）贴进来，dodoer 用它连。这串东西每次 Chrome 重启都换，所以只是退路。实测就是这么连上的。
- **保持一条连接**：连上后不断开，所有标签的会话都在这一条连接上（`Target.attachToTarget`，flatten）。这样用户只在连接时点一次允许，不是每个操作点一次。实测：每条新连接 Chrome 都弹一次窗，断开再连也要再点。
- **断了怎么办**：Chrome 退出、重启、用户关了开关，连接就断，Chrome 的标签从 `list_tabs` 里消失。**不自动重连**（重连会让 Chrome 再弹窗，没人在等的弹窗只会吓人）：状态变成「未连接」，智能体下次要用 Chrome 时回一句「Chrome 没连上，请用户在 dodoer 里点连接 Chrome」，用户点了再连。dodoer 启动时也不自动连。
- **文件是旧的**（Chrome 退出后文件还在、端口没人听）：连不上就按「未连接」处理，提示用户先打开 Chrome。
- Chrome 版本低于 144、没有这个文件：设置页说明要升级 Chrome 或打开开关。

### 5.2 Chrome 的标签怎么进 dodoer

- `BrowserSurface` 加一种 `External(ExternalHandle)`，`SurfaceKind` 加 `external`。`ExternalHandle` 里是 CDP 的 target id 和 session。内嵌 webview 才有的操作（位置、显示隐藏、缩放、冻结画面、查找）对它是空操作。
- 连上后 `Target.setDiscoverTargets`：Chrome 里每个 `page` 类型的 target 登记成一个标签。标签 id 是 dodoer 自己发的 uuid，和内置标签一个样子，CDP 的 target id 不出 dodoer。
- 每个标签记一个来源：**智能体开的**（经 `browser_open_tab` 建的）还是 **用户开的**（其余全部）。
- 状态同步：`Page.frameNavigated`（主框架）、`Page.loadEventFired`、`Target.targetInfoChanged` 更新 `BrowserTabState` 的 `url` / `origin` / `title` / `loading`，走 `browser/hooks.rs` 里内置标签用的同一组函数。
- `owner_window` 填固定的 `chrome`：它不属于任何 dodoer 窗口。
- **只接要用的标签**：没共享的用户标签只登记、不 attach，不在它上面开任何 CDP 域，对那个页面没有任何影响；共享了才 attach。
- `browser_list_tabs`：**用户开的、没共享的标签不列出来**（内置浏览器会列出域名，但那里的标签本来就是给工作用的；用户日常 Chrome 里开着什么网站不该让智能体知道）。列出来的每一项加一个可选字段 `browser: "chrome"`。老服务器不认识这个字段，会丢掉，不影响别的。

### 5.3 读和操作

| 工具 | CDP |
|---|---|
| `browser_snapshot`、点击 / 输入 / 选择（脚本部分） | `Page.createIsolatedWorld` 建隔离 world，`Runtime.evaluate` 在里面跑 `agent.bundle.js`，和内置的 `eval_in_world` 同一个契约 |
| 真点击、悬停 | `Input.dispatchMouseEvent`，接在 `dispatch_pointer` 上。**接上一个要操作的标签时先开 `Emulation.setFocusEmulationEnabled`**（让页面认为自己有焦点、看得见）：实测后台新开、从没显示过的标签不开它收不到点击，开了就收得到，`isTrusted` 为真；标签被别的标签盖住、窗口最小化时也收得到。所以不用为了一次点击把标签切到前台，也不用退回脚本派发的点击。共享收回时把它关掉。副作用：开着时页面的 `visibilityState` 是 `visible`，「切到后台就暂停」的页面不会暂停 |
| `browser_console_messages` | `Runtime.consoleAPICalled`、`Runtime.exceptionThrown`，喂进现有的控制台存储（`browser/console.rs`） |
| `browser_screenshot` | `Page.captureScreenshot`（元素截图用 clip） |
| `browser_open_tab` / `browser_navigate` / `browser_close_tab` | `Target.createTarget` / `Page.navigate` / `Target.closeTarget`，地址先过 `address_refusal` 和 5.5 的名单。智能体只能关自己开的标签 |
| `browser_eval` | `Runtime.evaluate` 在页面自己的 world。Chrome 上另有一个开关，见 5.4 |
| 页面弹的 `alert` / `confirm` / `beforeunload` | `Page.javascriptDialogOpening`：不替用户答，这次操作回「页面弹了对话框：<文字>」，对话框留给用户在 Chrome 里点 |

输入文字第一版仍由页面侧脚本派发（和别的平台一样）；真键盘输入（`Input.insertText`）等真点击验收过再加。

### 5.4 共享：谁的标签、什么级别

用户定的规则（2026-11-14）：

- **智能体开的标签**：按浏览器设置里的「默认共享级别」自动共享（出厂「读取并操作」），和内置浏览器一个设置。名单拦的网站除外。
- **用户开的标签**：默认不共享，用户在 dodoer 的面板里点了才交给智能体（选「读取」或「读取并操作」）。共享绑在域名上，页面离开这个域名就收回（现有规则）。
- **`browser_eval`（执行智能体自己写的代码）**：Chrome 上单独一个开关「在 Chrome 里执行代码」，出厂关。点击、输入、读页面都不需要它。内置浏览器的那个开关不管 Chrome。

内置标签的共享是「前端读设置、向后端申请」，由标签所在的窗口来做。Chrome 的标签不在任何窗口里，所以默认共享级别由前端启动时和改动时推给后端（和站点规则 `browser_set_host_rules` 同一种做法），后端在智能体开的标签每次落到一个新域名时按它共享；用户在面板里对某个标签点了「停止共享」，这个标签在这个域名上不再自动共享（`applyDefaultAgentGrant` 的那套记忆规则，搬到后端）。

这改了 `browser/agent.rs` 开头那句「没有任何东西是自动共享的」的适用范围：对智能体在 Chrome 里开的标签，级别是用户在设置里选的；后端只是不再等一个不存在的窗口来申请。

### 5.5 敏感网站名单

**这是唯一真正管用的边界。** 智能体自己新开的标签也带着用户全部的登录状态，「只让它碰自己开的标签」挡不住它打开邮箱。所以 Chrome 有一张自己的名单（和内置浏览器的站点规则分开存，因为内置的规则连用户自己的浏览一起拦，这里只拦智能体）：

- 名单上的域名：智能体打不开、跳不过去（`browser_blocked`）；标签不管怎么到了那里（点链接、重定向），共享立刻收回，也不会自动再给；用户也不能把这样的标签共享出去。**用户自己在 Chrome 里照常访问，dodoer 不拦人。**
- 第一次打开「连接 Chrome」时给一份建议名单让用户勾：常见邮箱（`mail.google.com`、`outlook.live.com`、`mail.qq.com` 等）、支付（`paypal.com`、`alipay.com` 等）、密码管理器的网页版，外加用户自己填的银行和公司后台。之后在设置里改。
- 名单按域名匹配（含子域名）。它拦的是顶层页面；页面里嵌的别的域名的框架本来就读不到（快照只读主框架所在的文档，现有行为）。

### 5.6 人接手

- **看得见**：智能体开的标签放在 **单独的 Chrome 窗口** 里，不往用户正在用的窗口里塞标签、不抢用户的当前标签。用户想看就切到那个窗口。实测（第 10 节第二轮）定下来的做法：
  - 第一个标签用 `Target.createTarget` 带 `newWindow` 开，得到智能体的窗口。
  - 之后的标签**从这个窗口里已有的标签上 `window.open`**（带 `noopener`），它们开在同一个窗口里。`Target.createTarget` 不带 `newWindow` 时落在用户的窗口，CDP 没有「开到指定窗口」的参数，所以不用它开第二个。为此窗口里留一个 dodoer 自己的起始标签（空白页，写一句「这个窗口是 dodoer 的智能体在用」），新标签都从它上面开；智能体的页面跳到哪里都不影响。
  - 窗口**最小化着也能干活**：点击和截图都正常。但 dodoer 不替用户把它收起来（用户 2026-11-14 定的：人能随时看到智能体在干什么更重要）；用户自己收起来也不影响智能体。
  - **开这个窗口时 Chrome 会跳到前面，躲不掉**：第三轮试了让窗口一出生就最小化（`windowState: "minimized"`），Chrome 没照做，照样跳了出来。所以窗口一条连接只开一次（智能体第一次在 Chrome 里开网页时），之后一直复用，**开出来就让它留在前面，不收起来**。这一跳正好也是告诉用户「智能体开始在 Chrome 里干活了」。用户 Chrome 全屏用的时候（用户平时就是），新窗口也是全屏的、在单独的一屏里；用户说目前问题不大。第 4 步再看：之后从这个窗口里 `window.open` 会不会又跳一次。
  - 退路：标签直接开在用户窗口的后台（开了焦点模拟后那里也收得到点击，不跳出来）。代价是智能体的标签和用户的混在一起，Chrome 里又做不了记号。
- **人来做一步**：碰到登录、验证码、付款确认，智能体照现在的办法在对话里问用户（侧栏「等你回答」）。dodoer 的面板里每个标签有「跳到这个标签」（`Target.activateTarget` + 把 Chrome 提到前面），用户做完回对话里说一声，智能体接着干。
- **把自己的页面交给智能体**：面板里列出 Chrome 现在开着的标签（标题和域名，只给用户看），点「交给智能体」。
- **立刻停手**：面板顶上一个「暂停」开关。打开后所有 Chrome 标签的读和操作一律拒绝（回「用户暂停了对 Chrome 的操作」），共享状态不动，关掉就恢复。断开连接是更彻底的停。
- **事后看**：每次读、点、输入都记在活动记录里（现有的 `emit_agent_activity`），在面板里按标签看。

### 5.7 谁能用

- 本机工作区的智能体：连上了就能用。
- 远端窗口对应的服务器：设置里「也借给远端工作区」开着时（出厂开，用户平时用的就是服务器上的智能体），`McpBrowserTools::scoped` 的范围 = 这个窗口自己的内置标签 + Chrome 里智能体开的和用户共享了的标签。别的窗口的内置标签仍然看不到。
- 借不借仍先看 app 本机的浏览器工具开关（`host_capabilities`）；连没连上 Chrome 是它之下的第二道。

### 5.8 智能体新开的标签开在哪

`browser_open_tab` 只有一个 `url` 参数，不加参数（加了就要动 codeg-mcp 的工具定义和借浏览器的协议，服务器得跟着升级）。设置里一项「智能体新开的网页开在：内置浏览器 / Chrome」，出厂内置浏览器，用户改成 Chrome。选了 Chrome 而它没连上时，不悄悄退回内置浏览器（那边没有登录状态，智能体会对着登录页白忙），直接回「Chrome 没连上」。

### 5.9 界面

- **设置 → 浏览器**加一节「Chrome」：两步说明、「连接 Chrome」/「断开」、连接状态、敏感网站名单、新标签开在哪、「在 Chrome 里执行代码」、「也借给远端工作区」。
- **面板**：工作区右上角浏览器入口旁，列 Chrome 的标签（智能体开的 / 用户共享的 / 用户没共享的三组）、每个标签的共享级别、「交给智能体」「停止共享」「跳到这个标签」、活动记录，顶上是连接状态和「暂停」。
- 十种语言的文案都要加。

## 6. 安全

- **连接要用户点头两次**：开关是用户在 Chrome 里开的，每次连接是用户在 Chrome 的弹窗里允许的。dodoer 只在用户点了「连接 Chrome」时发起连接，所以弹窗出现的时刻用户知道是谁在连。**开关开着时，本机别的程序也能来请求连接**，同样会弹窗；设置页写明：不是自己刚点了连接时出现的弹窗，一律点拒绝。
- **检查都在原处**：读之前看共享级别、读完再核对地址、操作前核对 ref 是否过期，全是现有的 `agent_*_core`。Chrome 没有绕过它们的路径。
- **风险说在前面**：用户日常的 Chrome 里是真实账户。网页上的文字可以诱导智能体（提示注入）；智能体开的标签默认是「读取并操作」，它能在名单之外的任何登录着的网站上替用户点和填。能挡住的只有 5.5 的名单和 5.6 的暂停。设置页打开这个功能时把这段话摆出来，让用户勾完名单再连。
- **不该碰的不碰**：没共享的用户标签不 attach、不列给智能体；`chrome://`、扩展页、`devtools://` 这些非 http(s) 的页面不登记。
- **远端**：能借到 Chrome 的服务器，其上的智能体拿到的权限和本机智能体一样。只连自己的服务器时没有新风险；连别人管的服务器的人把「也借给远端工作区」关掉。

## 7. 分步落地

每步一个 PR，可单独合并、回滚。Rust 只在 CI 上编译和测试；每步都要在 Mac 上的桌面包里验一次才算完。

0. **真机实测**（第 10 节）。`browser-agent/chrome-connect-probe.mjs`。已做，通过。
1. **CDP 客户端和连接**。已写（#213）。`src-tauri/src/browser/chrome/`：
   - `endpoint.rs`：`DevToolsActivePort` 在哪（macOS / Windows / Linux 的默认数据目录）、读它（没有 → `Missing`，系统不让读 → `Denied`，两种分开）、认用户手动贴的端点（第二行、两行一起、两行被单行输入框挤成一串、`ws://127.0.0.1:…` 地址；主机不是本机的一律不认）。
   - `cdp.rs`：一条 WebSocket 上的 CDP。`call(方法, 参数, session)` 按 id 等应答，30 秒没回算超时；其余的帧是事件，带着 `sessionId` 广播给订阅的人；连接一断，等着的调用全部以 `Closed` 结束。单条消息上限调到 256 MiB（长页面的截图是一整帧 base64）。
   - `link.rs`：`ChromeLink`，app 里唯一的那条连接和它的状态（未连接 / 等用户允许 / 已连接），未连接时带原因（开关没开、macOS 不让读、文件读不出、贴的不是端点、Chrome 没在跑、被拒绝、没人点允许、连接断了）。等允许最多 120 秒。已连接或正在连时再点连接什么都不做（再拨一次就是再弹一次窗）。断了不重连。
   - `commands/browser_chrome.rs`：`browser_chrome_status / connect / disconnect / open_privacy_settings` 四个命令，状态变化发 `browser://chrome` 事件。连不上不算命令出错，原因在状态里。
   - 设置 → 内置浏览器里多一张卡片「我自己的 Chrome」（`src/components/settings/chrome-connect-settings.tsx`）：两步说明、连接 / 取消 / 断开、每种原因各一句该怎么办；读不到文件时出现「粘贴地址来连接」一行和「打开系统设置」。卡片上写明是试验功能、现在只能连接。管理员关掉内置浏览器时不显示。
   - 这个模块在服务器版里也编译（它不碰 webview）：CI 对桌面版只做类型检查，测试只在服务器版那一格跑，不这样它的测试就没人跑。服务器版里没有任何东西调用它。
   - 「标签能不能收在同一个窗口」「什么情况下收得到真点击」没有放进产品代码里试，加在实测脚本里了（第 10 节），不用等桌面包。
2. **标签进注册表**。`BrowserSurface::External`、target 发现、来源标记、状态同步；面板列出标签。验收：智能体的 `browser_list_tabs` 里还看不到任何 Chrome 标签（都没共享），面板里看得到。
3. **读和操作**。隔离 world 里跑 bundle、真点击、控制台、截图、开 / 跳转 / 关标签、页面对话框；面板里「交给智能体」。验收：本机智能体能读、能填用户共享的标签。
4. **共享规则和人接手**。智能体开的标签自动共享、单独窗口（做法见 5.6）、敏感网站名单、暂停、跳到标签、「新标签开在哪」、Chrome 的执行代码开关。
5. **借给远端和收尾**。`scoped` 的范围规则、连接状态变了重新注册；`COWORK.md` 改动清单，本文档按实现更新。

第 3 步做完就能用本机智能体试填表，第 5 步做完服务器上的智能体才用得上。

## 8. 验收

在 Mac 上，Chrome 里打开远程调试开关，dodoer 设置里勾好名单：

1. 点「连接 Chrome」：Chrome 弹窗，点允许，dodoer 显示已连接。之后的操作不再弹窗。
2. 智能体调 `browser_list_tabs`：看不到用户开着的任何标签。
3. 面板里把一个登录着的网站的标签「交给智能体」（读取）：智能体看到它（带 `browser: "chrome"`），`browser_snapshot` 读到登录后的页面；要点击时回 `browser_control_required`。
4. 「新标签开在：Chrome」，让智能体打开一个要登录的网站并填一个表单：标签开在单独的 Chrome 窗口里，是登录后的页面，提交时页面收到的点击 `isTrusted` 为真；用户当前的窗口和标签没被动过。
5. 让智能体打开名单上的网站：回 `browser_blocked`。让它在别的页面上点一个通往名单网站的链接：到了之后读不到。用户自己在 Chrome 里打开那个网站：照常。
6. 智能体干到一半打开「暂停」：下一次操作被拒绝；关掉后继续。
7. 页面弹 `confirm`：智能体的这次操作回「页面弹了对话框」，对话框留在 Chrome 里。
8. 面板里点「跳到这个标签」：Chrome 到前面，切到那个标签。
9. 远端窗口里（服务器上的智能体）：第 3、4 步同样成立。关掉「也借给远端工作区」后看不到 Chrome 的标签。
10. 退出再打开 Chrome：dodoer 变成未连接，智能体用 Chrome 时被告知要用户重新连接；不点「连接 Chrome」就不弹窗。
11. 没共享的用户标签：在 Chrome 的 DevTools 里看不到它被附加过调试会话。

## 9. 已经定的事

用户 2026-11-14 定的：

- 接管日常用的 Chrome，不另开一个单独用户的 Chrome。
- 共享范围：用户开的标签点了才共享；敏感网站拉黑；智能体开的标签按设置里的级别自动共享。

按上面两条顺下来、我定的出厂值（设置里都能改）：

- 智能体新开的网页出厂仍开在内置浏览器，用户改成 Chrome 才开到 Chrome。
- 也借给远端工作区：出厂开。
- 在 Chrome 里执行代码：出厂关。
- 断开后不自动重连。

用户 2026-11-14 看了第三轮实测后定的：

- 智能体的窗口开出来留在前面，dodoer 不把它收起来：人能随时看到、随时接手更重要。Chrome 全屏时新窗口占一屏、会跳过去，用户说目前问题不大。

## 10. 实测结果

2026-11-14，用户的 Mac mini：macOS 27.0.1，正在跑的 Chrome 是 154.0.8037.98（默认用户，开着 11 个标签），`browser-agent/chrome-connect-probe.mjs`。

| 问题 | 结果 |
|---|---|
| 默认用户上连不连得上 | 连得上。之前看到的那份「Chrome 150 上连不上」的报告（ChromeDevTools/chrome-devtools-mcp#2283）实际是下一行的 macOS 权限问题 |
| 读 `DevToolsActivePort` | 文件在，终端读不了（`EPERM`，macOS 27 的 app 数据保护）。这次是在 Chrome 里打开文件、手动把端点给脚本的 |
| 允许弹窗 | 每条连接一次；连了两次，弹了两次 |
| 连着时 Chrome 顶上的提示条 | 第一轮用户说 Chrome 没弹出什么；第二、三轮有「正受到控制」的提示，断开后消失（第三轮当场问的） |
| `navigator.webdriver` | `false` |
| `Target.createTarget`（后台）、`Target.attachToTarget`、`Page.createIsolatedWorld` | 都能用 |
| 后台标签：读页面、隔离 world、截图 | 都正常（`visibilityState` 是 `hidden`，截图 146KB） |
| 后台标签：`Input.dispatchMouseEvent` 的点击 | 页面没收到 |

由此改的设计：5.1 加了 macOS 权限那一步和手动贴端点的退路。不需要走扩展。

第二轮（同一天，同一台机器，脚本加了窗口和点击的几项；一条连接，弹窗一次）：

| 问题 | 结果 |
|---|---|
| 后台新开的标签，真点击 | 没收到（`hidden`） |
| 同一个标签开 `Emulation.setFocusEmulationEnabled` 之后 | 收到了，`isTrusted` 为真；页面的 `visibilityState` 变成 `visible`。注意：这一轮里两次点击之间还截了一次图，是哪一样起的作用没分开，第三轮把截图挪到了后面 |
| `Target.createTarget` 带 `newWindow` | 开出单独的窗口；里面的标签真点击收得到 |
| 再 `Target.createTarget`（不带 `newWindow`） | 落在用户的窗口，不是智能体的窗口 |
| 从智能体窗口里的标签 `window.open` | 开在智能体的窗口；新标签真点击收得到 |
| 这时被盖住的那个标签（`hidden`，没开焦点模拟） | 真点击也收得到。所以「后台」本身不是收不到的原因，从没显示过才是（或者焦点模拟对它不是必需的）；产品里一律开焦点模拟，不依赖这个区别 |
| 把智能体的窗口最小化（`Browser.setWindowBounds`） | 真点击收得到，截图成功（115KB） |
| 新窗口出现时 | 用户说「浏览器也弹出了」：Chrome 自己到了前面 |

由此改的设计：5.3 的真点击改成「先开焦点模拟」，不再有「只对当前标签有效、后台退回脚本点击」这条；5.6 定了智能体的标签怎么收在同一个窗口里（`window.open`），窗口可以最小化着用；新窗口跳出来的问题留给第三轮。

第三轮（同一天，同一台机器；跳没跳出来、提示在不在是脚本当场问的）：

| 问题 | 结果 |
|---|---|
| `Target.createTarget` 带 `windowState: "minimized"` | Chrome 没照做：窗口开出来是 `fullscreen`，Chrome 跳到了前面。新窗口是全屏的，说明用户的 Chrome 多半是全屏用的（macOS 上全屏 app 的新窗口也全屏、占一屏） |
| 普通方式开新窗口 | 也跳到了前面 |
| 再 `Target.createTarget`（不带 `newWindow`） | 这次落在「别的窗口」（第二轮是用户的窗口）：落在哪个窗口看 Chrome 最后用的是哪个，拿不准。再次说明第二个标签要用 `window.open` 开 |
| 从智能体窗口里的标签 `window.open` | 开在智能体的窗口（和第二轮一样） |
| 真点击 | 每一种情况都收到了，`isTrusted` 为真，开不开焦点模拟都一样。这次后台新开的标签一开始就是 `visible`，第二轮那个「没收到」没能复现，也就没分清当时是什么起的作用；产品里照旧一律开焦点模拟 |
| 最小化的窗口里点击、截图 | 正常（和第二轮一样） |
| 「正受到控制」的提示 | 连着时有，断开后没了 |

由此定的：开窗口时跳出来躲不掉，窗口一条连接只开一次、开了就复用（5.6）；dodoer 一直连着，所以这条提示会一直在，连接没断用户就看得见（第 11 节）。


还没测的（要等桌面包在用户的 Mac 上试，不挡开工）：

- dodoer（一个有界面的 app，不是终端）第一次读那个文件时，系统设置的「文件与文件夹」里会不会出现 dodoer 的「Google Chrome」开关；不出现的话只能让用户给「完全磁盘访问权限」或用手动贴端点。
- 前端收到 `surface: "external"`、`owner_window: "chrome"` 的 `browser://state` 时现有的标签 store 怎么处理（预期是没有对应的工作区标签、存了但没人用；不行就不向标签 store 广播，只给面板）。

## 11. 已知局限

- 只有 macOS、只认 Google Chrome，要 144 以上，要用户自己开开关。
- Chrome 每次重启都要重新点一次「连接 Chrome」和「允许」。
- 连着的时候 Chrome 顶上一直有「正受到控制」的提示（Chrome 自己加的，dodoer 去不掉）。好处是用户一眼看得出 dodoer 还连着；不想看到它就断开。
- 智能体第一次在 Chrome 里开网页时，Chrome 会跳到前面（开智能体自己的窗口时躲不掉）。
- macOS 27 起要先在系统设置里给 dodoer 读 Chrome 数据目录的权限；这一步 dodoer 替不了用户。
- 真点击靠焦点模拟送到后台和最小化的标签上（实测可行）；开着时页面以为自己一直在前台。
- Chrome 里有多个用户（头像菜单里的）时，它们在同一个进程里，dodoer 都看得到；第一版不区分，面板里一起列出来。
- 标签没法在 Chrome 里做记号：哪些标签交给了智能体，只能在 dodoer 的面板里看。
- 反爬严的网站（看 CDP 痕迹的那类风控）可能认出来；这个方案不承诺过得了它们。
- 文件上传、下载、打印对话框、Chrome 自己的权限弹窗（定位、通知）智能体处理不了，要人在 Chrome 里点。
- 远程调试开关是 Chrome 的新功能，行为可能随版本变。CDP 的方法尽量用标了稳定的；焦点模拟（`Emulation.setFocusEmulationEnabled`）和窗口那几个（`Browser.getWindowForTarget`、`Browser.setWindowBounds`、`Target.createTarget` 的 `windowState`）是试验性的，Chrome 改了要跟着改。

## 12. 放弃或推后的方案

- **另开一个单独数据目录的 AI Chrome**（本文档的上一版）。登录状态要重新来，人接手也要换一个浏览器，用户不要。以后要做的话，标签这一层完全一样，只是 5.1 换成「dodoer 自己用 `--user-data-dir` + `--remote-debugging-pipe` 启动」，共享规则可以更宽。
- **Chrome 扩展 + Native Messaging**。不依赖 Chrome 的版本和那个开关，也不用过 macOS 的目录权限，标签上还能做记号、能用标签组；但要多写一个扩展、一个 Native Messaging 程序，还要解决扩展的分发。实测官方入口连得上，所以不走；以后那个入口变了再说。
- **用启动参数给日常 Chrome 开调试端口**。Chrome 136 起默认数据目录上的 `--remote-debugging-port` / `--remote-debugging-pipe` 不生效。
- **另写一个 `BrowserToolAccess` 实现，和内置的并排**。对上游文件的改动最少，但读前检查、读后核对地址、活动记录这些安全逻辑要抄一份，两份迟早不一致。
- **给智能体配现成的 `chrome-devtools-mcp --autoConnect`**。本机智能体今天就能这么用；但服务器上的智能体够不到 Mac，没有共享级别、名单和暂停，工具也是另一套。
- **全部标签自动「读取并操作」**。做得到，用户没选：网页上的文字一旦诱导了智能体，代价是真实账户。
