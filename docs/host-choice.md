# 智能体用哪台电脑

状态：2026-11-14 写完第一版（本文和代码在同一个 PR）。还没在两台电脑上实测。

**2026-11-15：这套规则（自动 + 固定）要换掉。** 用户否决了它：出门后用另一台设备看进度不该影响智能体在哪台电脑上干活，换电脑要人说了才换。新设计在 `docs/devices.md`，代码还没改；改完之前这里写的仍然是现在的行为。

## 1. 问题

一个人可能在两台电脑上都开着 dodoer，都连着同一台服务器，都把浏览器（`docs/remote-browser.md`）或命令行（`docs/host-ssh.md`）借给它。服务器上智能体的一次调用只能去一台。

原来的规则只有一条：去最近获得焦点（或最近注册）的那台（remote-browser 4.4）。2026-11-14 用户在 MacBook 上打开了「让智能体用我的 Chrome」，叫服务器上的智能体去开网页，网页却开在了另一个房间的 Mac mini 的内置浏览器里：

- MacBook 自己的浏览器工具开关是关的，没登记 `browser` 能力，调用只能去 Mac mini（这一条另一个 PR 修了：开 Chrome 开关时顺手把浏览器借出去）；
- 就算两台都借了，去哪台也是「最近点过哪个窗口」定的，用户看不到、也改不了。

`ssh desktop` 是同一个注册表、同一条规则，有同样的问题。

## 2. 目标

1. 用户看得到：现在连着哪几台电脑，每台借出了什么，浏览器调用和 `ssh desktop` 现在各去哪台。
2. 自动的规则更合用户的意思：有电脑开了「让智能体用我的 Chrome」时，浏览器调用优先去它。
3. 用户可以固定：浏览器固定用某一台，命令行固定用某一台，两样可以不是同一台。坐在 A 电脑前（或者用手机、网页）让智能体用 B 电脑的浏览器，是正常用法。
4. 固定的那台不在时，调用失败并说清楚，**不悄悄换一台**。智能体在错的电脑上干活，正是固定要防的。

不做的：

- 智能体自己在工具参数里选电脑（`browser_*` 的工具定义不改；`ssh desktop-<名字>` 这种按电脑起的别名以后可以加，见第 8 节）。
- 一个标签记住它在哪台电脑上（现在换了电脑，原来那台上的标签就够不到了，和原来焦点变了时一样）。

## 3. 电脑是谁（`src-tauri/src/host_device.rs`）

服务器要在 socket 断了重连、两边 app 都重启之后，还认得「Mac mini」是哪台，所以每个桌面 app 在 `host_register` 里多带一个 `device`：

```json
{"action": "host_register", "capabilities": ["browser", "chrome", "shell"],
 "window": "remote-workspace-2", "shell": {…},
 "device": {"id": "9f3c…32 位十六进制", "name": "James's Mac mini"}}
```

- `id`：第一次用到时随机生成，写在 `~/.codeg/device-id`，以后不变。跟硬件无关，只发给用户自己连的服务器。读不到也写不了时就不带 `device`（每次启动都变的 id 比没有更糟）。
- `name`：macOS 的「电脑名称」（`scutil --get ComputerName`），没有就用主机名；和门户「我的设备」里的名字是同一个来源（`cowork_connect::this_device_name`）。
- 服务器只收像样的：`id` 是 8～64 位的字母数字、`-`、`_`；`name` 压成一行、最多 80 个字符（`HostDevice::sound`）。不像样的当没带。
- 老的桌面 app 不带 `device`：照常接调用，在列表里显示成「未命名的电脑」，不能被固定。
- 名字是人名（「James's Mac mini」），服务器的 INFO 日志会发到 Sentry，所以日志里只写 id 的前 8 位，不写名字。

同一台电脑的两条 socket（重连的瞬间、以后一个 app 开两个窗口）在列表里并成一台，借出的东西取并集。

## 4. 去哪台（`web/host_registry.rs` 的 `Inner::pick`）

对一种能力（`browser` 或 `shell`）：

1. **固定了**：只看那台电脑上借出这种能力的 socket，取最近用的；一个都没有就失败（`PinnedAway`），不看别的电脑。
2. **没固定**（自动）：
   - 浏览器：在借出 `browser` 的里面，带 `chrome` 的排前面，其余按最近用的；
   - 命令行：按最近用的。

`chrome` 是桌面端在 `browser` 旁边多报的一个能力（`remote_proxy.rs` 的 `DesktopWsHost::capabilities`）：这个远端窗口的「让智能体用我的 Chrome」开着就报。它不让服务器多调什么，只是告诉服务器「用户指的是这台」。没有 `browser` 的 `chrome` 不算（Chrome 是经借出的标签通道到的）。开关一变，桌面端重新注册一次（`refresh_host_registrations`）。

固定的那台不在时智能体看到的话：

- 浏览器工具：和没有桌面时一样的错误码（`browser_unavailable`），说明换成「The user fixed this workspace's browser to the computer "…", and no desktop app there lends its browser right now. Ask the user to open this workspace in the desktop app on that computer, or to choose another computer from the computers icon at the foot of the sidebar, then try again.」
- `ssh desktop`：503，说明是同样意思的一句。

## 5. 选择存在哪儿（`web/host_choice.rs`）

存在**服务器**上，不存在某个 app 里：

- 这样才谈得上「我在 A 电脑前，让智能体用 B 电脑的」——选择对从哪儿发话的人都一样，网页和手机上也能改；
- 一台 codeg-server 就是一个员工的，所以「服务器的」就是「这个人的」。

`app_metadata` 的 `host_choice.choices`，JSON：`{"browser": {"id", "name"} | null, "shell": … }`。名字一起存，是为了那台不在线时还能显示「固定用 Mac mini（没连上）」。启动时 `host_choice::restore` 读回来交给注册表。

接口（`cowork::api_routes`，`server_info` 的 feature 是 `host_choice`）：

- `POST /api/get_host_devices` →

  ```json
  {"devices": [{"key": "…", "id": "…" | null, "name": "…", "browser": true, "chrome": false, "shell": true}],
   "choices": {"browser": null, "shell": {"id": "…", "name": "…"}},
   "browserNow": "<某台的 key>" | null, "shellNow": …}
  ```

  `devices` 按最近用的排；`browserNow` / `shellNow` 是现在调用会去的那台（固定的不在就是 `null`）。
- `POST /api/set_host_choice`，`{"capability": "browser" | "shell", "deviceId": "…" | null}` → 改完后的同一份状态。只能选现在连着的电脑（要拿它的名字）；`null` 是回到自动。

没有做成事件推送：列表很短，前端 30 秒问一次（面板开着时 5 秒），窗口回到前台时再问一次；`get_host_devices` 进了遥测的低采样名单。

## 6. 界面（`src/components/cowork/status-bar-host-choice.tsx`）

侧栏底部多一个图标（两块屏幕的那个），跟在「借出这台电脑」「我的 Chrome」后面；手机宽度在状态栏里。

- **在哪儿出现**：网页里，和桌面 app 的远端窗口里；有电脑连着、或者固定过什么的时候。本机窗口不出现（它的智能体就在这台电脑上）。服务器没有 `host_choice` 时不出现。
- **点开**：
  - 连着的电脑，一台一行：名字、「这台」（桌面 app 里，是自己这台时；问 app 的 `host_device` 命令）、借出了什么（浏览器 · Chrome · 命令行，或「没有借出」）。
  - 「浏览器」「命令行（ssh desktop）」各一行：一个下拉（自动 / 每台有 id 的电脑），下面一句「现在用：…」；自动时再说一句自动的规则。
- **固定的电脑不在**：图标变琥珀色，那一行写「固定用「…」，但它现在没借出这一项，智能体的调用会失败。在那台电脑上打开 dodoer，或者重新选。」电脑全走了但还固定着时图标也留着，不然没地方改回自动。

文字在 `src/lib/cowork/i18n.ts`（英、简、繁）。

## 7. `ssh desktop` 跟着换电脑（`host_ssh/client.rs`）

`ssh desktop` 用 `ControlMaster` 把一条连接留 10 分钟。原来 `ControlPath` 是固定的 `<目录>/cm`，所以换了电脑（固定到另一台，或者自动规则选了另一台）之后，10 分钟内的 `ssh desktop` 还会顺着旧连接进**原来那台**。

现在 `ControlPath` 是 `<目录>/cm-<那台主机密钥的 sha256 前 8 位>`：`config` 本来就在借出的电脑变化时重写（`User` 跟着第一台走），换了电脑就换了 socket 名，下一条 `ssh desktop` 新开连接。旧连接没人用，到时间自己退。固定的选择一变，注册表也会重发一次 shell 列表，让 `config` 立刻重写。

## 8. 以后

- 按电脑起别名：`ssh desktop-<名字>`（`codeg-cli desktop proxy --device <id>`），让智能体在两台电脑之间自己选。
- 浏览器调用记住标签在哪台电脑上，换了选择之后老标签还能用完。
- 列表变化用事件推，不用轮询。

## 9. 验收

要两台电脑（或一台电脑加一台装了新版的），服务器升到带 `host_choice` 的版本：

1. 两台都打开这个工作区的远端窗口。侧栏底部出现图标，点开看到两台，名字对，「这台」标在自己这台上。
2. 两台都借出浏览器，都不开 Chrome 开关：「现在用」是最近点过的那台；到另一台点一下窗口，几秒后变过去。
3. 在 A 上打开「让智能体用我的 Chrome」：「现在用」变成 A，并且在 B 上点窗口也不变。叫智能体开一个公网网页，开在 A 的 Chrome 里。
4. 把浏览器固定到 B：智能体开网页去 B。退出 B 的 dodoer：图标变琥珀色，智能体开网页得到「fixed … to the computer "B"」的说明，A 上什么都没开。
5. 改回自动：恢复第 3 步的行为。
6. 两台都借出命令行，`ssh desktop hostname` 是最近用的那台；固定到另一台后立刻再跑，是另一台（不用等 10 分钟）。
7. 重启服务器：固定的选择还在。
