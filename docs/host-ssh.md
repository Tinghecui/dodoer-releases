# 把桌面电脑的命令行借给远端工作区

状态：方向定了，Mac 上的实测做过了（第 4 节），产品代码还没写。

## 1. 问题

远端工作区的智能体跑在服务器上，碰不到用户自己的电脑：读不到上面的文件，跑不了命令，看不了日志。现在只借得到桌面 app 的内置浏览器标签（`docs/remote-browser.md`）。本地的事只能另开本机工作区，那是另一个智能体、另一段对话，服务器这边的上下文带不过去。

2026-11-14 测「接管 Chrome」时就是这样：每一步都要用户在 Mac 终端里跑命令，再把结果贴回对话。

## 2. 目标和不做的

目标：服务器上的智能体在同一段对话里，直接在用户的电脑上跑命令、传文件、看日志——知识、记忆、对话都留在服务器，电脑只出手。

- 用标准 SSH：智能体本来就会用 `ssh`、`scp`、`rsync`、端口转发，不新造工具。
- 只经过 dodoer 桌面 app：app 开着、用户打开了开关、app 正连着这个工作区，三条同时成立才连得上。任何一条不成立，服务器到这台电脑没有路。
- 用户的电脑不需要公网地址，不用开系统的「远程登录」，不用另打隧道。
- 密钥每次借出现生成，借出结束就作废。

不做：

- 限制智能体只能动某个文件夹。有 shell 就做不到真正的限制，不假装能做到。开关是全有或全无。
- 看屏幕、点软件（电脑操作）。那是另一件事，另案再议。
- Windows、Linux 桌面。第一版只做 macOS。
- app 没开时也能连。这正是要挡住的。

## 3. 一句话方案

桌面 app 借出时，在本机起一个只听 `127.0.0.1` 的 SSH 服务；服务器上的 `ssh desktop` 经 codeg-server 向桌面 app 要一条通道，桌面 app **主动**再连一条 WebSocket 到服务器，把它和本机的 SSH 服务接起来。

```
服务器                                             用户的电脑
agent ── ssh desktop
          │ ProxyCommand: codeg-cli desktop proxy
          ▼
      codeg-server ──（已有的 /ws/events）host_tunnel ──▶ dodoer 桌面 app
          ▲                                                  │ 主动拨出
          └──────────── /ws/host-tunnel（新，二进制）◀───────┤
                                                             ▼
                                              sshd（127.0.0.1，临时密钥）
```

两条连接都是桌面端拨出去的，和借浏览器用的是同一个方向，所以家里、公司路由器后面的电脑都能用。

## 4. 实测结果（2026-11-14，macOS 27.0.1，系统自带 OpenSSH 10.3）

脚本是 `scripts/host-ssh-probe.sh`：用普通账号起系统自带的 `sshd`，同一件事从终端直接做一遍、经 SSH 会话做一遍。

| 测了什么 | 结果 | 对方案的影响 |
|---|---|---|
| 不开端口、走管道服务一次连接（`sshd -i`） | **不行**。认证通过后 `Could not create new audit session: setaudit_addr failed: Invalid argument`，连接被关 | 苹果的 sshd 要给每个会话建审计会话，没有网络地址的连接建不了。改成只听 `127.0.0.1` |
| 只听本机端口（`sshd -D`，`127.0.0.1`） | 可以 | 就用这种 |
| 会话属于哪个登录会话 | 终端和 SSH 都是 `Aqua`（用户已登录的桌面会话） | 钥匙串、启动软件都能用，比系统「远程登录」强 |
| 用钥匙串（写入、读回、删除） | 两边都可以 | 签名、取登录凭据的命令不会因为 SSH 失败 |
| 启动软件（计算器） | 可以 | |
| 读 Chrome 的数据目录 | 两边都被系统拦 | 权限跟起它的 app 走（实测里是终端，产品里是 dodoer），见 5.6 |
| 读要「完全磁盘访问」的目录 | 两边都被系统拦 | 同上 |
| 读桌面文件夹 | 两边都可以（终端已有这项权限） | 同上 |
| 截屏 | 两边都不行（终端没有录屏权限） | 没得出结论；截屏不在这个功能里 |
| 交互式终端、scp | 可以 | |
| 找得到的工具 | 直接跑命令：`git python3`；登录环境：`git node brew python3` | 要把用户登录环境的 `PATH` 交给 SSH 会话，见 5.1 |

没验过的：

- 由 dodoer（而不是终端）起 `sshd` 时，权限是不是确实记在 dodoer 名下、系统设置里出不出现对应的开关。第 1 步做完才能测。
- 这台 Mac 上没有 Rust 工具链（没找到 `cargo`），「让 Mac 代替服务器编译」现在做不了，要先装。

## 5. 设计

### 5.1 桌面端的 SSH 服务

新目录 `src-tauri/src/host_ssh/`，只在桌面 app（`tauri-runtime`）里。

- **用系统自带的 `/usr/sbin/sshd`**，不内嵌 SSH 服务端。以当前用户身份跑，`-D` 前台模式，配置、密钥都在 app 自己的临时目录里（权限 700），和系统的「远程登录」、`/etc/ssh`、`~/.ssh` 都无关。
- 配置要点（实测里跑通的那份，加上几条收紧）：

  ```
  ListenAddress 127.0.0.1        # 局域网、公网都连不到
  Port <随机>
  HostKey <临时目录>/host_key     # 每次借出现生成（ssh-keygen）
  AuthorizedKeysFile <临时目录>/authorized_keys   # 只有服务器这次给的公钥
  AuthenticationMethods publickey
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  UsePAM no
  StrictModes no
  AllowUsers <当前用户>
  AllowAgentForwarding no
  X11Forwarding no
  PermitTunnel no
  GatewayPorts no
  SetEnv PATH=<用户登录环境的 PATH>
  ```

- **`PATH`**：直接 `ssh 主机 命令` 只有系统默认的 `PATH`，找不到 `node`、`brew`。app 已经会用登录 shell 查命令（`commands/acp.rs` 的 `-lic`），同样的办法取一次 `PATH`，用 `SetEnv` 交给会话。
- **什么时候跑**：开关打开，**并且**至少有一个远端窗口连着带 `host_ssh` 的服务器。开关关掉、最后一个这样的连接断开、app 退出，都立刻杀掉整个进程组并删临时目录。
- **app 异常退出**：`sshd` 会变成孤儿继续听着。两道保险：`sshd` 由一个看着父进程的小包装起（父进程没了就杀掉它）；app 启动时按上次留下的 pid 文件清理一遍。孤儿期间通道已经断了，服务器连不过来；本机别的程序没有私钥也登不上。
- **端口只听本机**是相对最初设想（完全不开端口）的退让：这台电脑上的其他程序能连到这个端口，但没有服务器手里的私钥过不了认证。要做到完全不开端口，得在 app 里内嵌 SSH 服务端（见第 10 节）。

### 5.2 通道

- 服务器的 `server_info.features` 加 `host_ssh`。老服务器没有它，桌面端什么都不做。
- 桌面端的 `host_register` 在借出命令行时多报一个能力 `shell`，并带上这次的主机信息：

  ```json
  {"action":"host_register","capabilities":["browser","shell"],"window":"remote-workspace-3",
   "shell":{"host_key":"ssh-ed25519 AAAA…","user":"<登录名>","platform":"macos"}}
  ```

- 服务器要一条通道时，在已有的 `/ws/events` 上发：

  ```json
  {"type":"host_tunnel","tunnel_id":"<随机>","client_key":"ssh-ed25519 AAAA…"}
  ```

  桌面端把 `client_key` 记进 `authorized_keys`（这个连接此前没给过的话），然后**主动**连 `GET /ws/host-tunnel?id=<tunnel_id>`（认证和它的 `/ws/events` 一样），连上后在这条 WebSocket 和 `127.0.0.1:<端口>` 之间原样搬字节（二进制帧）。连不上本机 SSH 服务、开关已关，就回 `{"action":"host_tunnel_result","tunnel_id":…,"error":"…"}`。
- 服务器把桌面端拨进来的这条和等着的那一头（5.3）配上对，两边原样搬字节；15 秒没人拨进来就失败。`tunnel_id` 一次有效。
- 选哪台电脑：和借浏览器一样，最近注册或最近获得焦点的那个带 `shell` 能力的 host。
- **一条 SSH 连接一条 WebSocket，靠 SSH 自己的连接复用压住数量**（5.3 的 `ControlMaster`）。Cowork 的 nginx 对 `/ws/` 是每分钟 20 个新连接，超了会被 fail2ban 封 IP；所以 codeg-server 自己再限一道（每分钟最多 6 条新通道），超了直接回「稍后再试」，不让请求走到 nginx 那里去。真不够用再改成一条 WebSocket 里跑多路。

### 5.3 服务器端：`ssh desktop`

- codeg-server 在数据目录下维护 `host-ssh/`（700）：

  ```
  id_ed25519        # 这次借出的私钥，600；借出结束就删
  known_hosts       # 桌面端报上来的 host_key
  config            # 下面这段
  ```

  ```
  Host desktop
    HostKeyAlias dodoer-desktop
    User <桌面端报的登录名>
    IdentityFile <目录>/id_ed25519
    IdentitiesOnly yes
    UserKnownHostsFile <目录>/known_hosts
    StrictHostKeyChecking yes
    ProxyCommand <codeg-cli 的绝对路径> desktop proxy
    ControlMaster auto
    ControlPath <目录>/cm-%C
    ControlPersist 10m
    ServerAliveInterval 30
  ```

- 第一次借出时在 `~/.ssh/config` 最前面加一行 `Include <目录>/config`（带注释说明是谁加的；文件不存在就建）。这样 `ssh desktop`、`scp`、`rsync`、`git` 都直接能用，不用带参数。
- **`codeg-cli desktop proxy`**（新子命令）：按 `codeg-cli` 现有的规则找到本机的 codeg-server（智能体的 shell 里有 `CODEG_CLI_ENDPOINT_FILE`），带 token 连上去，把自己的标准输入输出接到 5.2 的通道上。没有桌面 app 借出时在标准错误里说明白：「没有桌面 app 借出命令行：请在 dodoer 桌面 app 里打开这个工作区，并打开『把这台电脑借给智能体』」。
- 私钥是服务器上的一个文件，不是只在内存里（`ssh` 客户端要读文件）。它只有这个账号能读，借出结束就删，而且**单有它没用**：到那台电脑的路只有 codeg-server 里的通道这一条，通道只在桌面 app 借出时存在。
- 服务器上别的账号用不了：入口要这个账号的 codeg-server 的 token。Cowork 里每个员工一个 codeg-server，只够得着自己连上来的那台电脑。

### 5.4 开关和可见性

- 桌面 app 设置里一个开关「把这台电脑的命令行借给远端工作区的智能体」，**默认关**。说明文字写清楚：打开后，远端工作区的智能体能以你的身份在这台电脑上执行任何命令。
- 借出期间，远端窗口状态栏有常驻标记；点开能看到现在有几条连接、最近跑的命令，一键断开（断开 = 关开关）。
- 命令记录：`sshd` 配 `ForceCommand` 指向 app 写的一个小脚本，它把 `$SSH_ORIGINAL_COMMAND` 记一行再照常执行。记在 app 的日志里，只留最近若干条。

### 5.5 智能体怎么知道

codeg-mcp 多一个工具组（设置里和浏览器、电脑操作并排），里面一个工具 `desktop_shell_status`：说现在有没有电脑借出、是什么系统、怎么用（`ssh desktop '命令'`），以及规矩（删除、覆盖、改系统设置之前先问用户）。没借出时说怎么打开。

### 5.6 macOS 的权限

- 实测里权限两边完全一样，说明 SSH 会话的权限跟起它的 app 走。产品里就是 dodoer：给 dodoer 开了「完全磁盘访问」，SSH 会话就读得到；没开就读不到。用户只面对 dodoer 这一个名字。
- dodoer 现在是 ad-hoc 签名，每次更新后系统可能把它当成新 app，权限要重新给。这是签名的事，不在这里解决。

## 6. 安全

- 打开开关 = 把这台电脑上你这个账号的全部权限交给远端工作区的智能体，也就交给了那台服务器。服务器被攻破，或者智能体被网页、文件里的恶意内容带偏，都可能在你的电脑上执行命令。所以默认关、借出时常驻提示、能一键断开、命令有记录。
- 没有新的对外入口：电脑上只多一个本机端口，服务器上只多一条要 token 的路径。
- 密钥不复用：主机密钥、客户端密钥每次借出重新生成。
- 不借给本机 daemon（连接 `-1`）：本机工作区的智能体本来就在这台电脑上。

## 7. 分步

每一步一个 PR，Rust 只在 CI 上编；要在 Mac 上验的步骤给 PR 打 `macos-build` 标签出测试包。

| 步 | 做什么 | 做完能验什么 |
|---|---|---|
| 0 | 实测脚本 | 已完成（第 4 节） |
| 1 | 桌面端：开关、起停 `sshd`、临时密钥、`PATH`、异常退出清理；设置页里一个「自检」（app 自己连一次、跑 `echo`） | Mac 上打开开关，自检通过；关开关、退出 app 后端口没了；dodoer 名下的权限是否生效 |
| 2 | 通道：`host_ssh`、`shell` 能力、`host_tunnel`、`/ws/host-tunnel`、`codeg-cli desktop proxy`、服务器上的密钥和 `ssh` 配置 | 在服务器终端里 `ssh desktop sw_vers` 有结果；关开关后立刻连不上 |
| 3 | 智能体和界面：MCP 工具组、状态栏标记、一键断开、命令记录 | 智能体自己在 Mac 上完成一次排查；记录里看得到命令 |
| 4 | 文档（`COWORK.md`）、Cowork 侧 nginx 的核对、发版 | |

## 8. 验收

1. 开关默认是关的；关着时服务器上 `ssh desktop` 失败，并说明怎么打开。
2. 打开开关后，服务器上 `ssh desktop 'sw_vers -productVersion'` 返回这台 Mac 的版本。
3. `scp` 传一个文件过去再传回来，内容一致。
4. `ssh desktop 'node -v'` 找得到用户装的 node（`PATH` 生效）。
5. 关开关：正在跑的会话立刻断，新的连不上，Mac 上那个端口没了。
6. 退出 dodoer：同上。强杀 dodoer 后再启动，没有残留的 `sshd`。
7. 从局域网另一台机器连这台 Mac 的那个端口：连不上。
8. 服务器上另一个账号跑 `ssh desktop`：连不上。
9. 智能体在对话里用 `ssh desktop` 做完一件事；桌面 app 的记录里看得到它跑的命令。
10. 老版本桌面 app 连新服务器、新桌面 app 连老服务器：都和现在一样，没有报错。

## 9. 局限

- 全有或全无，没有按文件夹、按命令的限制。
- app 关了、电脑睡了就连不上，夜里无人值守的任务碰不到这台电脑。
- 只有 macOS。
- 智能体的读写文件工具仍然作用在服务器上；电脑上的文件只能通过命令改。合适的用法是代码在服务器上改，同步过去跑和调试。
- 看不到屏幕。
- 本机端口对这台电脑上的其他程序可见（过不了认证）。

## 10. 放弃或推后的方案

- **服务器直接 SSH 到电脑（系统远程登录 + 固定密钥）**：只对内网互通的人有效，电脑一直开着端口，生产机上长期放着能登录个人电脑的密钥。
- **自己定义 `local_exec` 之类的 MCP 工具**：scp、rsync、端口转发、交互终端都得一个个重做。
- **在 app 里内嵌 SSH 服务端（russh）**：能做到完全不开端口，app 还能逐条看到、拦下命令，Windows 也能用。代价是 exec、pty、sftp、端口转发都要自己接，代码多得多，而这里的 Rust 只能靠 CI 编。先用系统 sshd 把整条路走通；要上 Windows 或者要逐条确认命令时再换，通道和服务器那一半不用动。
- **`sshd -i` 走管道**：实测不行（第 4 节）。
- **一条 WebSocket 里跑多路 SSH 连接**：先靠 `ControlMaster` 复用，不够再做。
- **服务器智能体委派给电脑上的智能体**：要电脑上另装并登录一套智能体；以后可以叠在 `ssh desktop` 上面试。
- **借出电脑操作**：调带界面的软件时需要，另案。
