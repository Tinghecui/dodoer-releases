// 把 desktop-e2e 一次 run 的结果记进 AI QA 的 Mac 台账（私有仓库 cowork-codeg 的分支 ai-qa/mac-memory 的 ledger.json）。
// 哪一步验的是哪个 PR / 哪条故事写在 ledger-map.json。公开镜像的 desktop-e2e-artifacts.yml 在 run 结束、产物搬完以后调，
// 只记公开 main 上的 run（每晚、手动跑 main）：desktop/pr/<n> 上跑的是那个 PR 的代码，不记。
//
// 台账格式同 .cowork/ai-qa/mac/record.mjs（源仓库）：
// - changes["PR<n>"]：新的在前、留 4 条，env 写 "mac-e2e"（Mac 测试员的是 "mac"）；
// - stories["<编号>"]["mac-e2e"]：{ last, history }（测试员的在 ["mac"]，每天 P0 那轮按它的 last 判断这一版跑没跑过，不混在一起）；
// - 最新一条也是 mac-e2e、结论没变时原地换成这一次的（每晚都跑，不然几天就把测试员的结论挤出那 4 条）。
// 没过的步骤记 fail，不另开 issue：main 上的 desktop-e2e 红了，report-status 报回 product 的提交，那边已经开 ci-red issue。
// 前面的步骤没过、这一步「没跑」的记 blocked；这次 run 里压根没有的（比如 PR 上不跑 Intel）不记。
// 公开日志里只写记了几个、各是什么结论，不写说明。
//
// 用法：
//   node ledger.mjs eval <数据目录>                  只算结论，打出 JSON（不碰台账）
//   node ledger.mjs write <数据目录> --repo <o/r> --run <run id> --version <被测版> [--run-url <地址>]
//     要 GH_TOKEN（能推私有仓库）。推不上去就重拉重来，最多 5 次（同 record.mjs）
// 数据目录：每台机器一个子目录（desktop-e2e-out-<机器>-attempt<N> 解开的，名字里带 macos-15 / macos-15-intel / ubuntu），
// 里面只用 result-phase<N>.json、update/result-update.json、native/result-native.json。同一台机器有几次 attempt 的取最后一次。
// 来历：源仓库 .cowork/journal/2026-11-22-e2e-mac-ledger.md
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

export const BRANCH = "ai-qa/mac-memory"
export const ENV = "mac-e2e"
const here = fileURLToPath(new URL(".", import.meta.url))

export function loadMap(file = join(here, "ledger-map.json")) {
  return JSON.parse(readFileSync(file, "utf8")).targets || {}
}

// 子目录名 → 哪台机器
export function machineOf(dir) {
  if (/ubuntu|linux/i.test(dir)) return "linux"
  if (/intel|x64|x86/i.test(dir)) return "macos-x64"
  if (/macos/i.test(dir)) return "macos-arm64"
  return ""
}

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"))
  } catch {
    return null
  }
}

// 数据目录 → [{ machine, suite, phase, name, ok, detail }]
export function loadResults(root) {
  const latest = new Map()
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    const machine = machineOf(name)
    if (!machine || !statSync(dir).isDirectory()) continue
    const attempt = Number(name.match(/attempt(\d+)/)?.[1] || 0)
    const prev = latest.get(machine)
    if (!prev || attempt > prev.attempt) latest.set(machine, { attempt, dir })
  }
  const out = []
  const add = (machine, suite, r, phase) => {
    for (const s of Array.isArray(r?.steps) ? r.steps : [])
      out.push({
        machine,
        suite,
        phase: String(s.phase ?? phase ?? ""),
        name: String(s.name || ""),
        ok: s.ok === true,
        detail: String(s.detail ?? ""),
      })
  }
  for (const [machine, { dir }] of latest) {
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      const m = f.match(/^result-phase(\d+)\.json$/)
      if (m) add(machine, "dom", readJson(join(dir, f)), m[1])
    }
    add(machine, "update", readJson(join(dir, "update", "result-update.json")))
    add(machine, "native", readJson(join(dir, "native", "result-native.json")))
  }
  return out
}

const matches = (c, r) =>
  r.suite === c.suite &&
  (c.phase == null || r.phase === String(c.phase)) &&
  (c.machine ? r.machine === c.machine : r.machine.startsWith("macos")) &&
  r.name.includes(c.step)

const skipped = (r) => !r.ok && /^没跑/.test(r.detail)

// 每个目标的结论：一项没过 = fail；前面挂了、这一步没跑 = blocked；全过 = pass（有 human 的记 partial）；有一项这次没有就不记
export function evaluate(results, map) {
  const rows = []
  for (const [id, t] of Object.entries(map)) {
    const per = (t.checks || []).map((c) =>
      results.filter((r) => matches(c, r))
    )
    if (!per.length || per.some((rs) => !rs.length)) continue
    const all = per.flat()
    const failed = all.filter((r) => !r.ok && !skipped(r))
    const machines = [...new Set(all.map((r) => r.machine))].sort()
    const human = t.human || []
    let verdict, notes
    if (failed.length) {
      verdict = "fail"
      notes = `没过：${failed[0].name}（${failed[0].machine}）${failed.length > 1 ? ` 等 ${failed.length} 项` : ""}`
    } else if (all.some(skipped)) {
      verdict = "blocked"
      notes = "前面的步骤没过，这几步没跑到"
    } else {
      verdict = human.length ? "partial" : "pass"
      notes = t.note || ""
    }
    rows.push({
      id,
      verdict,
      notes,
      human: verdict === "fail" ? [] : human,
      machines,
      steps: all.length,
    })
  }
  return rows
}

// 北京时间的日期（同 record.mjs）
export const today = (now = Date.now()) =>
  new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10)

// 一条记进 history（新的在前、留 4 条）：最新一条也是 mac-e2e 的、结论一样时原地换掉。
// mine：这条是不是 mac-e2e 记的（changes 里看 env；stories 的 ["mac-e2e"] 下面全是）
export function push(list, e, mine = (x) => x?.env === ENV, max = 4) {
  const old = Array.isArray(list) ? list : []
  const same = mine(old[0]) && old[0]?.verdict === e.verdict
  return [e, ...(same ? old.slice(1) : old)].slice(0, max)
}

// 改台账（就地改 ledger，也返回它）
export function apply(ledger, rows, { version, date, run, runUrl }) {
  ledger.changes ||= {}
  ledger.stories ||= {}
  for (const r of rows) {
    const tail = `desktop-e2e run ${run}（${r.machines.join("、")}，${r.steps} 步）`
    const notes = `${r.notes}${r.notes ? "。" : ""}${tail}`.slice(0, 300)
    const e = {
      version,
      date,
      env: ENV,
      verdict: r.verdict,
      notes,
      ...(r.human?.length ? { human: r.human.slice(0, 10) } : {}),
      ...(runUrl ? { run: runUrl } : {}),
    }
    if (/^PR\d+$/.test(r.id)) {
      const old = ledger.changes[r.id] || []
      const title = old.find((x) => x.title)?.title
      ledger.changes[r.id] = push(old, { ...e, ...(title ? { title } : {}) })
    } else {
      // 故事的条目不带 env（同 record.mjs），环境是上一层的键
      const s = { ...e }
      delete s.env
      const history = push(ledger.stories[r.id]?.[ENV]?.history, s, Boolean)
      ledger.stories[r.id] = {
        ...ledger.stories[r.id],
        [ENV]: { last: history[0], history },
      }
    }
  }
  const prs = rows.filter((r) => /^PR/.test(r.id)),
    sts = rows.filter((r) => !/^PR/.test(r.id))
  ledger.runs = [
    {
      date,
      version,
      env: ENV,
      run: runUrl || String(run),
      partial: false,
      passed: prs.filter((r) => r.verdict === "pass").length,
      stories: sts.length,
      storiesPassed: sts.filter((r) => r.verdict === "pass").length,
      findings: 0,
    },
    ...(ledger.runs || []),
  ].slice(0, 30)
  return ledger
}

function writeOnce(repo, rows, meta) {
  const sh = (cmd, args) =>
    execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  const dir = mkdtempSync(join(tmpdir(), "e2e-ledger-"))
  const url = `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git`
  sh("git", ["clone", "-q", "--depth", "1", "--branch", BRANCH, url, dir])
  const f = join(dir, "ledger.json")
  const ledger = readJson(f) || {}
  writeFileSync(f, JSON.stringify(apply(ledger, rows, meta), null, 2) + "\n")
  const g = (...a) => sh("git", ["-C", dir, ...a])
  g("add", "ledger.json")
  g(
    "-c",
    "user.name=ai-qa",
    "-c",
    "user.email=ai-qa@users.noreply.github.com",
    "commit",
    "-qm",
    `ai-qa mac-e2e: run ${meta.run} ${rows.map((r) => r.id).join(" ")} [skip ci]`
  )
  g("push", "-q", "origin", `HEAD:${BRANCH}`)
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const [cmd, root, ...rest] = process.argv.slice(2)
  const opt = (n) => {
    const i = rest.indexOf(n)
    return i >= 0 ? rest[i + 1] : undefined
  }
  if (!root || !["eval", "write"].includes(cmd)) {
    console.error(
      "用法：ledger.mjs eval|write <数据目录> [--repo o/r --run id --version v --run-url url]"
    )
    process.exit(2)
  }
  const rows = evaluate(loadResults(root), loadMap(opt("--map")))
  if (cmd === "eval") {
    console.log(JSON.stringify(rows, null, 2))
    process.exit(0)
  }
  const repo = opt("--repo"),
    run = opt("--run"),
    version = opt("--version")
  if (!repo || !/^\d+$/.test(run || "") || !version || !process.env.GH_TOKEN) {
    console.error("write 要 --repo、--run（数字）、--version 和 GH_TOKEN")
    process.exit(2)
  }
  const count = (v) => rows.filter((r) => r.verdict === v).length
  const line = `${rows.length} 项（pass ${count("pass")}，partial ${count("partial")}，fail ${count("fail")}，blocked ${count("blocked")}）：${rows.map((r) => `${r.id} ${r.verdict}`).join("，")}`
  if (!rows.length) {
    console.log("这次 run 里没有 ledger-map.json 对得上的步骤，不记台账")
    process.exit(0)
  }
  const meta = { version, date: today(), run, runUrl: opt("--run-url") }
  for (let i = 0; i < 5; i++) {
    try {
      writeOnce(repo, rows, meta)
      console.log(`Mac 台账：记了 ${line}`)
      process.exit(0)
    } catch (e) {
      console.log(
        `台账没推上去（第 ${i + 1} 次）：${String(e.message)
          .split("\n")[0]
          .replace(/x-access-token:[^@]+@/g, "")}`
      )
      execFileSync("sleep", [String(5 + i * 10)])
    }
  }
  console.log("Mac 台账：5 次都没推上去")
  process.exit(1)
}
