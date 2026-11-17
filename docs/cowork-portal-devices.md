# 门户吊销设备后，断开它已经开着的连接

状态：codeg 这一半已实现（#387 的三个 PR：登记表、断开接口和 `/ws/events`；两种隧道；这份文档）。cowork 那一半（nginx 把设备编号传给 daemon、cowork-web 吊销时调接口）在 cowork 仓库做，两边都上线以后才生效。代码在 `src-tauri/src/web/portal_device.rs`。

## 1. 问题

Cowork 的员工在门户「我的设备」里给每台 Mac 桌面版、手机 App 各发一个设备 token（`cwdev_<编号>_<随机>`），丢了一台就在门户里吊销它。nginx 每个请求都去问 cowork-web，所以吊销以后下一个接口请求就是 401；可是已经开着的 WebSocket 不会再经过这一关，nginx 给它们的 `proxy_read_timeout` 是 1 天。吊销以后，那台设备最长还能：

- 收一天的事件（对话内容、终端输出，`/ws/events`）；
- 挂着它借出的命令行和浏览器（借出登记在它的事件连接上）；
- 挂着已经打开的 `ssh` 隧道（`/ws/host-tunnel`）和内置浏览器隧道（`/ws/browser-tunnel`）。

以前唯一的办法是重启这个员工的整个 daemon，正在跑的对话和别的设备一起断。

## 2. 做法

daemon 认出每条长连接属于门户的哪台设备（nginx 给的请求头），在握手时登记下来；cowork-web 吊销设备以后直连 daemon 调一个接口，daemon 把这台设备登记着的连接都结束，并记住这个编号，之后再带它来的长连接握手回 401。

只借上游 dodoer「撤销即断」的思路，不搬它按设备发令牌那一套：我们的设备 token 由门户发、nginx 换成主令牌，daemon 仍然只认一把主令牌，登录检查（`web/auth.rs`、`web/proxy_auth.rs`、`cowork.rs`）一个字没动。取舍记在 `.cowork/journal/2026-11-16-portal-device-disconnect.md`。

## 3. 和 cowork 的约定

| 项 | 约定 |
| --- | --- |
| 头名 | `X-Cowork-Device` |
| 值 | 门户「我的设备」的设备编号：12 位小写十六进制（cowork 建设备时 `randomBytes(6).toString("hex")`），就是设备 token `cwdev_<编号>_<随机>` 中间那段，也是门户 `DELETE /api/me/devices/<编号>` 和审计 `device.revoke` 里的那个编号。不是 token，不是秘密 |
| 什么时候有 | 只在 nginx 凭设备 token 放行的请求上（nginx 的内部 location `/_cowork_dev_api`、`/_cowork_dev_ws`；本机入口和边缘入口一样）。门户单点登录的网页、用 daemon 密码的老 App、直连 daemon 的请求上都没有 |
| 谁给 | cowork-web 的 `/api/_device_auth` 在 200 的回答里多给 `X-Cowork-Device: <编号>`；nginx 用 `auth_request_set` 收下，在 server 级的 `proxy_set_header` 发给 daemon，没有时是空串、不发 |
| 防伪 | nginx 对每个转给 daemon 的请求都用自己的值覆盖这个头，客户端自己带的同名头到不了 daemon |
| 断开接口 | `POST /api/cowork_disconnect_device`，`Authorization: Bearer <daemon 主令牌>`，body `{"device":"<编号>"}`，回 `{"closed": <条数>}`；编号格式不对 400；请求带着 `X-Cowork-Device` 的 403 |
| 谁调、什么时候 | cowork-web 吊销设备（删掉那一行）**之后**调一次，直连 daemon 的监听地址、不经 nginx（和 cowork 现在以 root 调员工 codeg 接口的方式一样）。连不上、超时、404（老 daemon）只记日志，吊销照样成功。门户再点一次「在桌面 app 里打开」续 token（编号不变）时**不调** |
| nginx 挡住 | `/api/cowork_disconnect_device` 从外面来一律 404（和现在挡 `/api/cli_hello` 一样） |

daemon 这边怎么读这个头：恰好一个值、而且是 12 位小写十六进制（`^[0-9a-f]{12}$`）才算这台设备的。没有这个头就不算任何设备的；值不合格式（大写、长短不对、不是十六进制、空串）或者有两个以上的值，也当作没有，打一行 `warn`，不把值原样写进日志。

## 4. 头为什么可以信

头**只当标签用，不放开任何东西**。它唯一的用处是「吊销时找到要断的连接」和「断开过的编号再来握手被拒」。

- daemon 只在已经过了主令牌检查的请求上读它：三个 WebSocket 路由和 `/api` 都在 `auth::require_auth` 后面。
- 能把主令牌带到 daemon 的只有 nginx（替设备、替网页换进去的）、cowork 自己、知道 daemon 密码的员工本人。服务器上的智能体拿不到主令牌：它们的 `codeg-cli` 走只听本机、每次启动另发 token 的端口（`cli_run/listener.rs`），daemon 进程设了不可转储（`cowork.rs`）。带着主令牌本来什么都能做，伪造这个头最多把自己的连接标成某台设备、吊销那台时被断，拿不到任何东西。
- 从外面来的同名头由 nginx 覆盖，设备改不了、去不掉自己的编号。
- 不看对端地址：边缘入口（remote 模式）时 daemon 听私有链路上的地址，连进来的是另一台机器上的 nginx，按对端地址判断会把 nginx 也挡掉。
- 不加门户模式的开关：非 Cowork 部署里没人发这个头、没人调这个接口，行为不变。
- 断开接口拒绝带 `X-Cowork-Device` 的请求（403）：它只给 cowork-web 直连用，设备经 nginx 进来调不了；nginx 那边同时把这个路径 404 掉，两道。

## 5. 哪些连接会被断

只给长连接打标签，三种：

| 连接 | 断开时怎样 |
| --- | --- |
| `/ws/events`（事件连接） | 发关闭帧（代码 1008，原因 `device disconnected`）然后结束。这条连接上的 `host_register` 跟着注销：主机登记表里不再有它，借出的命令行、浏览器、Chrome 跟着没了。不发 `Detached`、不加新的 `DetachReason`（老的网页和桌面版不认新的值） |
| `/ws/browser-tunnel`（内置浏览器隧道） | 隧道结束 |
| `/ws/host-tunnel`（`ssh` 隧道桌面拨回来的那一端） | 握手时的编号跟着 socket 一起交给等着它的命令行那一端，接好的隧道两头都结束（命令行那一端看到连接关了）。断开过的编号来拨：先照原来的规矩认 `id`（没人等的仍是 404），认到了就回 401，并马上告诉等着的命令行那一端「这台设备已被断开」，不让它等满 15 秒 |

细节：

- 登记在握手处理函数里、升级之前做，每条连接一个取消标记（`CancellationToken`，取消了就一直是取消），随连接任务带走；连接不管怎么结束都自己注销。断开发生在握手和任务开始之间时，任务一开始就结束。
- 断开的回答 `closed` 是这次结束的连接条数（三种加起来），cowork-web 写进审计。同一个编号连调两次，第二次是 0。别的编号的、没编号的连接不受影响。
- 断开过的编号记在进程里，最多 1000 个，满了先丢最早的。之后再带这个编号来的长连接握手不升级，回 401，带 `WWW-Authenticate: Bearer realm="codeg"`（和 `web/auth.rs` 的 401 一样）。这是为了补上「nginx 刚问过 cowork-web 放行、cowork-web 随即吊销」之间那几毫秒：这时的握手已经在路上，晚于断开才到 daemon。编号不会复用（随机 6 字节，吊销就删行；续 token 不换编号，但也不调接口），所以记住不会误伤。daemon 重启后所有连接本来就要重新经过 nginx，不用存盘。
- 每次调接口打一行 `info`：编号和断开的条数。日志里没有任何 token。
- 桌面版收到任何关闭都会重连；重连被 nginx 回 401 后它停下，远端窗口显示口令被拒、不再自己重试。这次 401 会记进 cowork 的 `cowork-auth.log`，一台 Mac 开几个窗口也就几次，到不了 fail2ban 的门槛。daemon 这边不做「断开后反复关」之类会让客户端多试的事。

## 6. 不管哪些

- 普通接口请求不看这个头，也不记「哪台设备调了什么」：nginx 每个请求都问 cowork-web，吊销后的下一个就是 401。
- 已经发出去的一次性票据和能力地址：下载票 `/api/workspace_download/{ticket}`、`/api/backup_download/{ticket}`、office 预览代理的 `?cap=`，它们本来短命或跟着页面走；正在进行的普通 HTTP 请求（比如一个大文件下载）也不打断。
- 设备簿（`web/host_devices.rs`）不动：被吊销的 Mac 在设备面板里变成「不在线」，要从列表里去掉由用户点「忘掉」。门户的设备编号和设备簿的设备编号是两回事，不做对应。服务器为这台 Mac 写的 `ssh` 钥匙照原来的规矩，在最后一个借出的命令行没了 30 秒后撤掉。`ssh` 隧道的断开也不借用「停止借出」那套：那是设备簿的状态，会存下来、要在 Mac 上重新借出才恢复。
- 续 token（门户再点一次「在桌面 app 里打开」）不断开：编号不变，那台桌面版马上会用新 token 重连。账户停用、删除也不经过这里：那时 daemon 整个停掉。
- 命令行那一端（`/api/cli_host_tunnel`）是服务器本机的 `ssh` 开的，不带编号。
- 门户单点登录的网页（没有设备编号）退出门户后已开的连接，这次不管。
- 不加 `server_info` 的功能名：cowork-web 看接口是不是 404 就知道 daemon 新不新。

## 7. 新旧版本搭配

| daemon | cowork | 结果 |
| --- | --- | --- |
| 新 | 老（没有头、不调接口） | 和以前完全一样 |
| 老 | 新（头被忽略、接口 404） | cowork-web 记一行日志，吊销照样成功；已开的连接仍要等断开重连才断 |
| 新 | 新 | 吊销后几秒内断开 |

所以两边谁先上都没关系，最差是和以前一样等重连才断。没有数据库升级，撤回这一功能只要撤掉代码。

## 8. 测试和验收

- `web::portal_device` 的单元测试：读头的几种情况、登记和断开、握手前就被断开、断开过的被拒和 1000 个的上限、接口的 403 / 400。
- `src-tauri/tests/portal_device_disconnect.rs`：`/ws/events` 带编号 A 的连接断开后 3 秒内收到 1008 并结束、主机注销；B 和没编号的照常 `ping` / `pong`；再用 A 握手 401；接口的四种回答。
- `web::browser_tunnel`、`web::host_tunnel` 的测试：隧道断开后 3 秒内结束、只断这台设备的、断开过的再来拨回 401 并马上告诉命令行那一端（不需要 sshd）。
- 端到端（两边都上线以后）：用一台测试设备连上、开一个远端窗口，门户里吊销，daemon 日志里有断开那一行，桌面版窗口几秒内显示口令被拒；别的设备照常能用，正在跑的对话没断。
