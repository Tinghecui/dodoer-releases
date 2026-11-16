#!/usr/bin/env node
// 测试步骤里只重跑挂掉的用例：照常跑一遍，挂了、而且挂的是认得清的几条用例时，只把它们再单独跑一次，都过了这一步就放行。
// 用户 2026-11-16 定的：执行员的 PR 一红就派返工，偶发失败让执行员白花一次钱（源仓库 .cowork/journal/2026-11-16-ci-in-step-retry.md）。
// 思路照 jenny 的 dev-flow（ACanvasHERE/dodoer 的 scripts/dev-flow/checks.md「失败的测试只重跑一次」）。
//
// 下面任何一种都不重跑，照第一次的退出码算没过（日志写 RERUN SKIP 和原因）：
// - 认不出挂掉的用例，或者报告不完整：vitest 出现 Failed Suites（整个文件没跑起来）、Unhandled Errors（测试以外抛的错），
//   或者「Failed Tests N」「Tests N failed」和认出来的条数对不上；cargo 的 `test result: FAILED` 里的条数和认出来的对不上，
//   或者有测试程序没报完就退出了（崩了：只有 cargo 的「to rerun pass」、没有 test result）；编译没过当然也认不出；
// - 挂了超过 MAX_RERUN 条：一次挂这么多多半是真问题。
// 重跑只一次。重跑没过，或者重跑输出里有哪条没看到「过了」那一行（名字没匹配上、什么都没跑），这一步照样红（RERUN FAIL / RERUN NOT RUN）。
// 重跑才过的（RERUN PASS）不藏：每条打一个 ::warning 注解（标题「偶发失败，重跑才过」），这一步的 summary 里列出来、附第一次的报错。
//
//   用法：node scripts/ci/rerun-failed.mjs <vitest|libtest> <名字> <命令> <重跑命令>
//        vitest：重跑命令要带 --reporter=verbose（每条过了的用例打一行 ✓），挂掉的用例所在的文件拼在它后面，整个文件重跑。
//        libtest（cargo test）：命令要带 --no-fail-fast（不然第一个挂了的测试程序后面的都没跑），重跑命令以 `-- --exact` 结尾，
//        挂掉的测试的完整名字拼在它后面，只跑名字一模一样的那几条（参数和第一次一样，不用重编）。
//        <名字> 用在日志、注解和 summary 里（比如 job 名）。GITHUB_STEP_SUMMARY 有就往里写。
import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** 挂了超过这么多条就不重跑 */
export const MAX_RERUN = 3

export const ANNOTATION_TITLE = "偶发失败，重跑才过"

const ANSI =
  /\u001b\[[0-9;?]*[A-Za-z]|\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/** 去掉颜色（vitest 和 cargo 在 CI 上都是带颜色的） */
export function stripAnsi(text) {
  return text.replace(ANSI, "")
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// 文件名、测试名原样拼进重跑命令（不加引号），只认这些字符
const SAFE_FILE = /^[\w./@+-]+$/
const SAFE_TEST = /^[\w:.-]+$/

// vitest 的默认报告器把每条没过的用例在「Failed Tests N」下面列成 ` FAIL  文件 > 分组 > 用例`。
// 整个文件没跑起来（导入出错、beforeAll / afterAll 出错）和测试以外抛的错不对应任何一条用例，出现了就不算认得清。
function vitestFailures(output) {
  const text = stripAnsi(output)
  const lines = [...text.matchAll(/^ FAIL {2}(.+?) > .*$/gm)]
  const all = lines.map((m) => m[0].slice(" FAIL  ".length).trim())
  const files = [...new Set(lines.map((m) => m[1]))]
  const header = text.match(/Failed Tests (\d+) ⎯/)
  const summary = text.match(/^\s*Tests\s+(\d+) failed/m)
  let why = ""
  if (/Failed Suites \d+ ⎯/.test(text))
    why =
      "有整个测试文件没跑起来（Failed Suites：导入出错、beforeAll / afterAll 出错之类）"
  else if (/Unhandled Errors ⎯|^\s*Errors\s+\d+ errors?\b/m.test(text))
    why = "有测试以外抛出的错误（Unhandled Errors）"
  else if (all.length === 0)
    why = "认不出挂掉的用例（配置、导入、进程崩了之类，不是用例没过）"
  else if (
    !header ||
    !summary ||
    Number(header[1]) !== all.length ||
    Number(summary[1]) !== all.length
  )
    why = `汇总数对不上（Failed Tests ${header?.[1] ?? "没有"}、Tests ${summary?.[1] ?? "没有"} failed，认出 ${all.length} 条）`
  else if (!files.every((f) => SAFE_FILE.test(f)))
    why = "文件名里有不能直接拼进命令的字符"
  return { names: [...new Set(all)], why, args: files }
}

// 重跑用 --reporter=verbose：` ✓ 文件 > 分组 > 用例 3ms`，后面可能还有 (retry x1)、heap
function vitestPassed(output, name) {
  const re = new RegExp(
    `^\\s*✓ ${escapeRegExp(name)}(?: \\d+ms)?(?: \\((?:retry|repeat) x\\d+\\))*(?: \\d+ MB heap used)?\\s*$`,
    "m"
  )
  return re.test(stripAnsi(output))
}

// cargo test：libtest 把每条没过的打成 `test 模块::用例 ... FAILED`，每个没过的测试程序一行
// `test result: FAILED. N passed; M failed; …`；cargo 给每个没过的测试程序打一行 `error: test failed, to rerun pass …`，
// --no-fail-fast 时结尾还有 `error: N target(s) failed:`。测试程序崩了（abort、段错误）只有 cargo 那行、没有 test result，
// 它里面的用例一条也认不出来，所以这几个数都要对得上。`test x - should panic ... FAILED` 这种名字带空格的也认不出，条数就对不上
function libtestFailures(output) {
  const text = stripAnsi(output)
  const all = [...text.matchAll(/^test (\S+) \.\.\. FAILED\r?$/gm)].map(
    (m) => m[1]
  )
  const reports = [
    ...text.matchAll(/^test result: FAILED\. \d+ passed; (\d+) failed;/gm),
  ]
  const failed = reports.reduce((n, m) => n + Number(m[1]), 0)
  const hints = (text.match(/error: test failed, to rerun pass /g) ?? []).length
  const targets = text.match(/^error: (\d+) targets? failed:/m)
  let why = ""
  if (all.length === 0)
    why = "认不出挂掉的用例（编译没过、测试程序崩了之类，不是用例没过）"
  else if (failed !== all.length)
    why = `汇总数对不上（test result 里一共 ${failed} 条 failed，认出 ${all.length} 条）`
  else if (
    hints !== reports.length ||
    (targets && Number(targets[1]) !== reports.length)
  )
    why = "有测试程序没报完就退出了（崩了、被杀了）"
  else if (!all.every((n) => SAFE_TEST.test(n)))
    why = "测试名里有不能直接拼进命令的字符"
  const names = [...new Set(all)]
  return { names, why, args: names }
}

// 每种测试输出：怎么认挂掉的用例、重跑时拼什么、怎么算重跑过了、第一次的报错从哪一行开始到哪一行之前
const FORMATS = {
  vitest: {
    failures: vitestFailures,
    passed: vitestPassed,
    start: (line, name) => line.trim() === `FAIL  ${name}`,
    end: /^⎯/,
    file: (name) => name.split(" > ")[0],
  },
  libtest: {
    failures: libtestFailures,
    passed: (output, name) =>
      stripAnsi(output).split(/\r?\n/).includes(`test ${name} ... ok`),
    start: (line, name) => line === `---- ${name} stdout ----`,
    end: /^(---- \S+ stdout ----|failures:)$/,
  },
}

/** 命令本身不对（会漏测、认不出结果）：返回原因，对就返回空串 */
export function badCommands(kind, run, rerun) {
  if (kind === "vitest") {
    if (/(^|\s)--bail\b/.test(run))
      return "vitest 的命令不能带 --bail：中途停下的话没跑到的用例不会重跑"
    if (!/--reporter[= ]verbose\b/.test(rerun))
      return "vitest 的重跑命令要带 --reporter=verbose：靠它每条过了的用例打一行 ✓"
    if (/--shard\b/.test(rerun))
      return "vitest 的重跑命令不能带 --shard：挂掉的文件不一定分在同一片"
    return ""
  }
  if (kind === "libtest") {
    if (!/(^|\s)--no-fail-fast(\s|$)/.test(run))
      return "cargo test 要带 --no-fail-fast：不然第一个挂了的测试程序后面的都没跑，只重跑挂掉的几条会漏测"
    if (!/(^|\s)--exact$/.test(rerun.trim()))
      return "cargo test 的重跑命令要以 -- --exact 结尾：测试名拼在它后面，只跑名字一模一样的那几条"
    return ""
  }
  return `不认识的测试类型 ${kind}（vitest 或 libtest）`
}

/** 第一次没过以后：{ rerun, names, args?, reason? } */
export function plan(kind, output, max = MAX_RERUN) {
  const { names, why, args } = FORMATS[kind].failures(output)
  if (why) return { rerun: false, names, reason: why }
  if (names.length > max)
    return {
      rerun: false,
      names,
      reason: `挂了 ${names.length} 条，超过 ${max} 条，多半是真问题`,
    }
  return { rerun: true, names, args }
}

/** 重跑输出里没看到「过了」的那些 */
export function missingPasses(kind, output, names) {
  return names.filter((n) => !FORMATS[kind].passed(output, n))
}

/** 第一次的报错（这条用例那一段，最多 max 行） */
export function excerpt(kind, output, name, max = 30) {
  const { start, end } = FORMATS[kind]
  const lines = stripAnsi(output).split(/\r?\n/)
  const from = lines.findIndex((l) => start(l, name))
  if (from < 0) return ""
  const out = [lines[from].trim()]
  for (let i = from + 1; i < lines.length && out.length < max; i++) {
    if (end.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join("\n").trim()
}

// ::warning 的属性值和消息要转义（https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts）
const escapeData = (s) =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
const escapeProperty = (s) =>
  escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C")

function annotation(kind, label, name) {
  const file = FORMATS[kind].file?.(name)
  const props = [
    file && SAFE_FILE.test(file) ? `file=${escapeProperty(file)}` : "",
    `title=${escapeProperty(ANNOTATION_TITLE)}`,
  ]
    .filter(Boolean)
    .join(",")
  return `::warning ${props}::${escapeData(
    `${label}：${name} 第一次没过，单独重跑一次过了（这一步放行；偶发失败也要修，第一次的报错见这一步的 summary）`
  )}`
}

const cell = (s) => `\`${s.replace(/`/g, "'").replace(/\|/g, "\\|")}\``

/** 这一步的 summary（Markdown）。outcome：pass / fail / not-run（重跑退出 0 却没看到过了）/ skip（没重跑） */
export function summary({
  kind,
  label,
  outcome,
  names,
  reason,
  missing = [],
  first,
}) {
  // 前面可能有 vitest 自己写的 Test Report，不一定以空行结尾
  const out = [""]
  if (outcome === "skip") {
    out.push(
      `### ${label}：挂掉的用例没有单独重跑`,
      "",
      `原因：${reason}。这一步照常算没过。`
    )
    if (names.length)
      out.push("", ...names.slice(0, 10).map((n) => `- ${cell(n)}`))
    if (names.length > 10) out.push(`- ……一共 ${names.length} 条`)
    return `${out.join("\n")}\n\n`
  }
  out.push(
    outcome === "pass"
      ? `### ${label}：${names.length} 条用例第一次没过，单独重跑过了`
      : `### ${label}：挂掉的用例单独重跑还是没过`,
    "",
    outcome === "pass"
      ? `这一步放行。这是偶发失败，不是没事：每条都留了注解（标题「${ANNOTATION_TITLE}」），以后由调度台汇总。`
      : "这一步算没过，重跑的输出在日志里。",
    "",
    "| 用例 | 重跑 |",
    "| --- | --- |",
    ...names.map(
      (n) =>
        `| ${cell(n)} | ${!missing.includes(n) ? "过了" : outcome === "not-run" ? "没跑到" : "没过"} |`
    )
  )
  for (const n of names) {
    const text = excerpt(kind, first, n)
    if (text)
      out.push(
        "",
        `<details><summary>第一次的报错：${cell(n)}</summary>`,
        "",
        "~~~text",
        text,
        "~~~",
        "",
        "</details>"
      )
  }
  return `${out.join("\n")}\n\n`
}

// 跑一条命令：输出照常打出来，同时收着（stdout、stderr 分开收，免得半行拼在一起）
function sh(cmd) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const out = []
    const err = []
    child.stdout.on("data", (b) => {
      process.stdout.write(b)
      out.push(b)
    })
    child.stderr.on("data", (b) => {
      process.stderr.write(b)
      err.push(b)
    })
    child.on("error", (e) =>
      resolve({ code: 127, signal: null, output: String(e.message) })
    )
    child.on("close", (code, signal) =>
      resolve({
        code,
        signal,
        output: `${Buffer.concat(out).toString("utf8")}\n${Buffer.concat(err).toString("utf8")}`,
      })
    )
  })
}

function writeSummary(md) {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
}

export async function main(argv) {
  const [kind, label, run, rerun] = argv
  if (!kind || !label || !run || !rerun) {
    console.error(
      "用法：node scripts/ci/rerun-failed.mjs <vitest|libtest> <名字> <命令> <重跑命令>"
    )
    return 2
  }
  const bad = badCommands(kind, run, rerun)
  if (bad) {
    console.error(`::error::${bad}`)
    return 2
  }
  const first = await sh(run)
  if (first.code === 0) return 0
  // 前面的输出不一定以换行结尾；下面这些行（尤其是 ::warning）要单独成行
  const log = (line) => process.stdout.write(`\n${line}\n`)
  if (first.signal) {
    log(`RERUN SKIP ${label}: 被 ${first.signal} 停了`)
    return 1
  }
  const p = plan(kind, first.output)
  if (!p.rerun) {
    log(`RERUN SKIP ${label}: ${p.reason}`)
    writeSummary(
      summary({
        kind,
        label,
        outcome: "skip",
        names: p.names,
        reason: p.reason,
      })
    )
    return first.code
  }
  log(`RERUN ${label}: ${p.names.join(", ")}`)
  const second = await sh(`${rerun} ${p.args.join(" ")}`)
  const missing = missingPasses(kind, second.output, p.names)
  const report = (outcome) =>
    writeSummary(
      summary({
        kind,
        label,
        outcome,
        names: p.names,
        missing,
        first: first.output,
      })
    )
  if (second.code === 0 && missing.length === 0) {
    log(`RERUN PASS ${label}: ${p.names.join(", ")}`)
    for (const n of p.names) log(annotation(kind, label, n))
    report("pass")
    return 0
  }
  if (second.code === 0) {
    // 过滤条件什么都没匹配上也是退出 0：每条都要看到过了才算
    log(`RERUN NOT RUN ${label}: ${missing.join(", ")}`)
    report("not-run")
    return 1
  }
  log(`RERUN FAIL ${label}: ${p.names.join(", ")}`)
  report("fail")
  return second.code || 1
}

// 退出码用 exitCode，不 process.exit：输出到管道时可能还没写完
if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
