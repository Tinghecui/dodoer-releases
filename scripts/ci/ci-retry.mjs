#!/usr/bin/env node
// 公开镜像的 Test 第一次跑挂了时，判断是不是偶发失败，是就把没过的 job 自动重跑一次（只一次）。
// 公开仓库的 report-status.yml 在 Test 结束、结论是 failure、run_attempt 是 1 时调它；重跑了就把私有提交上的
// 「公开 CI / Test」报成 pending（不报 failure，product-ci-alert 不开 ci-red issue），第二次还挂才照常报 failure。
// 思路照 jenny 的 dev-flow（ACanvasHERE/dodoer 的 scripts/dev-flow/checks.md「自动重跑一次」「已知环境失败」），
// 规则见 COWORK.md「合并：auto-merge 和 product 的 ruleset」。
//
// 每个没过的 job 都满足下面之一才重跑，有一个是真失败就不重跑：
// 1. 没过的那一步的输出命中网络、托管机器出问题的模式（RETRY_PATTERNS）；
// 2. 没过的测试（cargo 的 `test x ... FAILED`、vitest 的 `FAIL  文件 > 用例`）全在 scripts/ci/flaky-tests.json 里、没过期。
// 名单只用来「重跑一次」，不跳过测试：重跑还挂就是红的。
//
//   用法：node scripts/ci/ci-retry.mjs <owner/repo> <run id>     （GH_TOKEN 要能读 Actions 日志、重跑 run）
//        GITHUB_OUTPUT 有就写 retried=true|false 和 reason=<一句话>
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// 只匹配没过的那一步自己的输出（不看命令文本、别的步骤）
export const RETRY_PATTERNS = [
  /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ERR_PNPM_FETCH_|ERR_PNPM_META_FETCH_FAIL/,
  /[Cc]onnection (reset|refused|timed out)|[Oo]peration timed out|[Tt]imeout was reached/,
  /failed to (download|fetch)|[Tt]emporary failure in name resolution|Resource temporarily unavailable/,
  /(502|503|504) (Bad Gateway|Service Unavailable|Gateway Time-?out)/,
  /The runner has received a shutdown signal|lost communication with the server/,
  /No space left on device/,
]

const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g

/** GitHub job 日志的一行去掉时间戳和颜色 */
export function cleanLine(line) {
  return line.replace(TIMESTAMP, "").replace(ANSI, "").replace(/\r$/, "")
}

/**
 * job 日志里每个没过的步骤的输出：每个「Process completed with exit code」往前到这一步的「##[group]Run」。
 * 一个也找不到（被取消、机器丢了、超时）时 found 为 false、lines 是整份日志，这时只认托管机器出问题的模式（见 judgeJob）。
 */
export function failedSteps(log) {
  const lines = log.split("\n").map(cleanLine)
  const steps = []
  let start = 0
  lines.forEach((l, i) => {
    if (l.startsWith("##[group]Run ")) start = i
    else if (/^##\[error\]Process completed with exit code/.test(l))
      steps.push(lines.slice(start, i + 1))
  })
  return steps.length > 0
    ? { found: true, steps }
    : { found: false, steps: [lines] }
}

/** 没过的测试名：cargo（完整模块路径）和 vitest（「文件 > 用例」） */
export function failedTests(lines) {
  const out = new Set()
  for (const l of lines) {
    const cargo = l.match(/^test (\S+) \.\.\. FAILED$/)
    if (cargo) out.add(cargo[1])
    const vitest = l.match(
      /^\s*(?:FAIL|×|✗)\s+(\S+\.test\.[cm]?[jt]sx?(?: > .+?)?)\s*(?:\d+ms)?$/
    )
    if (vitest) out.add(vitest[1].trim())
  }
  return [...out]
}

/** 名单里今天还有效的测试名；过期的单列出来（日志里提醒删掉或续期） */
export function activeFlaky(list, today) {
  const active = new Set()
  const expired = []
  for (const item of list?.tests ?? []) {
    if (
      !item?.test ||
      !item?.reason ||
      !/^\d{4}-\d\d-\d\d$/.test(item.expires ?? "")
    )
      continue
    if (item.expires >= today) active.add(item.test)
    else expired.push(item.test)
  }
  return { active, expired }
}

// 这几种 job 没过只会是代码的问题（格式、lint、workflow 语法），不重跑；它们的输出里有源码（rustfmt 的 diff），
// 源码里的 "failed to fetch" 这类字符串会被当成网络错误（2026-11-15 run 43686608097 的 Rust fmt）
const NEVER_RETRY = /^(Rust fmt|Frontend lint|Workflow lint|Desktop editions)$/
// diff 里的行（rustfmt、快照对比）不当成工具的输出
const DIFF_LINE = /^[-+]/

/** 一个没过的步骤：{ ok, reason }（name 是 job 名） */
function judgeStep(name, lines, found, active) {
  const output = lines.filter((l) => !DIFF_LINE.test(l)).join("\n")
  const hit = RETRY_PATTERNS.map((re) => output.match(re)).find(Boolean)
  if (hit) return { ok: true, reason: `${name}：${hit[0]}` }
  if (!found) return { ok: false, reason: `${name}：没找到没过的那一步` }
  const tests = failedTests(lines)
  if (tests.length === 0)
    return { ok: false, reason: `${name}：不是测试没过（编译、lint 之类）` }
  const unknown = tests.filter((t) => !active.has(t))
  if (unknown.length > 0)
    return {
      ok: false,
      reason: `${name}：${unknown.slice(0, 3).join("、")} 没过`,
    }
  return { ok: true, reason: `${name}：已知偶发 ${tests.join("、")}` }
}

/** 一个没过的 job 能不能重跑：它每个没过的步骤都能重跑才行。{ ok, reason } */
export function judgeJob(job, active) {
  if (NEVER_RETRY.test(job.name))
    return { ok: false, reason: `${job.name}：这种检查没过不是偶发` }
  const { found, steps } = failedSteps(job.log ?? "")
  const verdicts = steps.map((lines) =>
    judgeStep(job.name, lines, found, active)
  )
  return (
    verdicts.find((v) => !v.ok) ?? {
      ok: true,
      reason: verdicts.map((v) => v.reason).join("；"),
    }
  )
}

/** 整轮：没过的 job 全都能重跑才重跑 */
export function decide(jobs, flakyList, today) {
  const { active, expired } = activeFlaky(flakyList, today)
  if (jobs.length === 0)
    return { retry: false, reason: "没找到没过的 job", expired }
  const verdicts = jobs.map((j) => judgeJob(j, active))
  const bad = verdicts.find((v) => !v.ok)
  if (bad) return { retry: false, reason: bad.reason, verdicts, expired }
  return {
    retry: true,
    reason: verdicts.map((v) => v.reason).join("；"),
    verdicts,
    expired,
  }
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
}

function main() {
  const [repo, runId] = process.argv.slice(2)
  if (!repo || !runId) {
    console.error("用法：node scripts/ci/ci-retry.mjs <owner/repo> <run id>")
    process.exit(2)
  }
  const root = join(fileURLToPath(import.meta.url), "../../..")
  const flaky = JSON.parse(
    readFileSync(join(root, "scripts/ci/flaky-tests.json"), "utf8")
  )
  const failed = JSON.parse(
    gh([
      "api",
      `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
      "--jq",
      '[.jobs[] | select(.conclusion == "failure") | {id, name}]',
    ])
  )
  const jobs = failed.map((j) => {
    let log = ""
    try {
      log = gh(["api", `repos/${repo}/actions/jobs/${j.id}/logs`])
    } catch (e) {
      console.log(`读不到 ${j.name} 的日志：${e.message.split("\n")[0]}`)
    }
    return { name: j.name, log }
  })
  const today = new Date().toISOString().slice(0, 10)
  const d = decide(jobs, flaky, today)
  for (const t of d.expired)
    console.log(
      `::warning::flaky-tests.json 里的 ${t} 过期了，不再算偶发；删掉或续期`
    )
  for (const v of d.verdicts ?? [])
    console.log(`${v.ok ? "可重跑" : "真失败"}  ${v.reason}`)
  let retried = false
  if (d.retry) {
    gh(["run", "rerun", runId, "--failed", "-R", repo])
    retried = true
    console.log(`已重跑没过的 job：${d.reason}`)
  } else {
    console.log(`不重跑：${d.reason}`)
  }
  if (process.env.GITHUB_OUTPUT) {
    const reason = d.reason.replace(/\s+/g, " ").slice(0, 100)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `retried=${retried}\nreason=${reason}\n`
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
