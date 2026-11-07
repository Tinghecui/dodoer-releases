# 会话思维导图（jenny 私有版）

画布页默认显示会话思维导图。一个项目一张图，单向往右长：最左边是项目，右边一列是分类，再往右是会话，用灰色圆角框和单色曲线连起来（逻辑图样式）。页面左上角的切换按钮可以回到原来的自由画布。

## 怎么用

- 项目下拉框选项目。进入页面时，程序显示你当前会话所在的项目；没有当前会话时，显示上次看的项目。
- 一个分类默认显示最新的 8 个会话，其余收成“还有 N 个”，点一下再多显示 24 个。
- 点分类可以折叠或展开。折叠状态按项目记在 localStorage（`jenny:mindmap-collapsed:v1:<项目 id>`）。
- 点会话打开它。会话右边的 ⋯ 菜单可以“移动到”别的分类，或“移出分类”。
- 搜索框按会话标题和分类名过滤。分类名命中时，整个分类都显示。
- 会话标题后面的小图标说明它是怎么归类的：闪光图标是 Jev，手形图标是手动。鼠标停在会话上可以看到详细来源。
- 会话框右边和侧栏一样显示状态：未读是蓝点（标题加粗），运行中是转圈，已取消是叉，其余显示多久前有动静（`5m`、`3h`、`2d`）。
- 打开只会是空白的会话（智能体的历史里已经找不到它的记录文件，或者它从没拿到会话 id）不留在原分类，收进最后一个“无法打开”分支。这个分支默认折叠，点一下展开，展开状态也记在上面的 localStorage 里；搜索时照常显示命中的会话。运行中的会话不算；目前能按文件名判断的是 Claude Code、Codex 和 Grok，其他智能体的会话一律当作能打开。后端接口是 `conversation_unopenable_list`（`src-tauri/src/commands/conversation_taxonomy.rs`）。

## 分类从哪里来

1. 夜间：Codex 定时自动化 `codeg-conversation-mindmap` 每天 03:30 运行。它只读每个会话的标题和第一条提示词，然后重新整理分类树：可以新增、改名、合并、删除分类，也可以改写分类规则，并给每个会话重新归类。步骤见下面“夜间整理”。
2. 白天：新会话发出第一条提示词后，codeg 把这条提示词和现有分类的规则交给 Jev，由 Jev 选一个分类。Jev 的把握低于 50%，或者认为没有合适的分类时，会话留在“未分类”，等夜间整理。
3. 手动：用 ⋯ 菜单移动到别的分类，或者移出分类。夜间整理和 Jev 都不改你的决定：移到的分类还在，会话就一直在那里；移出分类的会话一直留在“未分类”。

只算项目的根会话：子代理委托出来的子会话和 loop 会话不上图。一个项目包括根文件夹和它的 worktree 子文件夹。

## 数据存放

- 没有新表，也没有迁移（见 `JENNY-FORK.md` 硬性规则 1）。每个项目一行，存在 `app_metadata` 表里，key 是 `jenny.conversation_taxonomy:folder:<根文件夹 id>`，值是 JSON。
- 值的内容：分类（id、父分类、名字、规则）；每个会话的归属（分类、来源 `nightly`/`jev`/`manual`、Jev 的把握、时间；手动移出分类的会话也记一条，分类为空）；新会话第一条提示词的前 400 个字符；上次整理的时间和说明；`revision`（每次夜间整理加 1）。
- 第一条提示词从这个功能上线后才开始记录。更早的会话只有标题可读。会话标题本来就取自第一条提示词，或者是 agent 写的总结。
- 存的值读不出来时，程序把它另存为 `<key>:unreadable`，然后按空图处理，不会丢掉原值。
- 分类图变化后，后端广播 `conversation-taxonomy://changed`，打开着的页面会自动刷新。

## 夜间整理

自动化按下面的步骤做。手动整理也用同样的步骤。

```bash
CLI=/Applications/dodoer.app/Contents/MacOS/codeg-cli
TMP=$(mktemp -d /tmp/codeg-mindmap.XXXXXX)

"$CLI" status --json                    # 选中的 Codeg 的 capabilities 里必须有 "taxonomy"
"$CLI" taxonomy projects --json         # needs_review 为 true 的项目才需要整理
"$CLI" taxonomy export <项目> -o "$TMP/<项目 id>-export.json"
# 读 export，写 plan
"$CLI" taxonomy apply <项目> "$TMP/<项目 id>-plan.json" --dry-run --json
"$CLI" taxonomy apply <项目> "$TMP/<项目 id>-plan.json" --json
rm -rf "$TMP"
```

- 必须先检查 `taxonomy` 能力。旧版 `codeg-cli` 不认识 `taxonomy` 这个命令，会把它当成提示词，启动一次 agent 运行。
- Codeg 没在运行时，先运行一次 `"$CLI" open --wait 2m`。还是连不上，就停止并报告失败。
- `<项目>` 可以写项目 id，也可以写项目路径。
- `needs_review` 的条件：项目至少有 3 个会话，而且从没整理过，或者上次整理后有新会话。
- export 里每个会话有 `title`、`first_prompt`（可能为空）、`category_id`、`source`、`confidence` 和 `new`（上次整理后新建）。只读这些，不去打开会话内容。
- `source` 为 `manual`、`category_id` 为 `null`，表示用户手动把会话移出了分类。
- export 顶层的 `exported_at` 是导出的时间，plan 里要原样写回（见下面）。

### plan 的格式

```json
{
  "categories": [
    {"id": "canvas", "parent_id": null, "name": "画布", "rule": "无限画布、思维导图和画布上的卡片、区域。不含侧栏和标签页。"},
    {"id": "canvas-export", "parent_id": "canvas", "name": "画布导出", "rule": "把画布导出成图片或文件。"}
  ],
  "assignments": {"101": "canvas", "102": "canvas-export", "103": null},
  "summary": "把“导出”从“画布”里拆成子分类；合并了两个很小的分类。",
  "exported_at": "2026-10-31T03:30:05.123456+00:00"
}
```

- `categories` 是整棵新树，会整个替换旧树。至少 1 个分类，最多 48 个；顶层最多 16 个；最多两层。
- `id`：小写字母、数字、`-`、`_`，以字母或数字开头，最长 48 个字符。不能是 `unclassified` 或 `__unclassified__`。含义不变的分类要沿用原来的 id。
- `name`：最长 40 个字符，同一父分类下不能重名。用简体中文，产品名、代码名保持原样。
- `rule`：必填，最长 600 个字符。写清楚什么会话属于这里，和最接近的分类怎么区分。白天 Jev 就靠这些规则给新会话归类。
- `assignments`：key 是会话 id（字符串），值是分类 id，或者 `null`（移出分类）。没列出的会话保持原来的归属，前提是它的分类还在。分类被删、又没重新归类的会话变成未分类。
- 手动放的会话不受 plan 影响（报告里的 `kept_manual`），除非它的分类被删除。手动移出分类的会话一直不受影响。
- `summary`：可选，最长 600 个字符。写这次改了什么、为什么改。页面上“分类是怎么来的”里会显示它。
- `exported_at`：可选，从 export 原样抄过来。codeg 把它记成这次整理的时间，所以 Codex 工作时新建的会话，下一次仍然算新会话。不写时，codeg 用 apply 的时间。
- 不认识的字段会被拒绝。出错时 `codeg-cli` 返回错误码 `bad_plan`，`message` 说明哪里不对。

### 分类怎样才算合理

- 分类是为了让人一眼找到同类会话。只建必要的分类：一个分类通常至少有 3 个会话，太小的并进相近的分类。
- 一个分类超过大约 25 个会话，而且能清楚分成几类时，再拆出子分类。
- 尽量稳定：意思没变的分类不改名、不改 id。只有明显更好时才改。
- 按会话要做的事分类（比如“画布”“发布”“登录”），不按 agent、日期或文件夹分类。

## 白天的 Jev 归类

- 什么时候触发：普通会话（不是子代理委托）发出第一条提示词，并且会话创建不到 30 分钟。超过 30 分钟说明是恢复的旧会话，不再归类。
- 什么时候不触发：项目还没有分类；会话已经有归属，或者被手动移出了分类。
- 怎么调用：`python3 ~/.agents/skills/jev/scripts/jev.py call`，60 秒超时，同一时间只跑一个。发给 Jev 的是项目名、会话标题、第一条提示词的前 2000 个字符，以及每个分类的路径和规则。Jev 也可以选 `unclassified`。
- 第一条提示词的前 400 个字符会先存下来，夜间整理会读到它。Jev 不可用时也会存。
- 归类失败不影响发消息，只在日志里记一条 `[taxonomy] first prompt`。
- 测试时可以用环境变量 `CODEG_TAXONOMY_CLASSIFIER` 换成别的命令；设为 `off` 就不调用 Jev。

## 排查

- 看某个项目的图：`codeg-cli taxonomy export <项目>`。
- 看哪些项目要整理：`codeg-cli taxonomy projects --all --json`。
- 夜间运行记录：Codex 应用的 Automations 页面。自动化设置为只在失败时通知。
- 撤销一次夜间整理：用上一次的 export 拼出 plan（分类和每个会话的 `category_id`），再 apply 一次。

## 代码位置

- 后端：`src-tauri/src/taxonomy/`（`model.rs` 规则和合并、`store.rs` 存取、`service.rs` 项目范围和导出、`classify.rs` Jev）、`commands/conversation_taxonomy.rs`、`web/handlers/conversation_taxonomy.rs`、`cli_run/taxonomy.rs`、`cli/taxonomy.rs`，以及 `acp/manager.rs` 里调用 `taxonomy::classify` 的地方。
- 前端：`src/components/canvas/mindmap/`、`src/stores/conversation-taxonomy-store.ts`、`src/stores/mindmap-view-store.ts`、`src/lib/conversation-taxonomy.ts`。
