#!/usr/bin/env node
// 先红核对（源仓库 .cowork/journal/2026-11-17-evidence-gate-red-check.md）：PR 新加、改过的测试放到修之前的代码上跑，看它们是不是真的会失败。
// 执行员正文里贴的「先红」是它自己抄的输出，审查员跑不了命令、核对不了真假；CI 只证明修好以后是绿的。这里真跑一遍。
//
// 公开仓库的 red-check.yml 在 pr/<n> 推上来时跑：pr/<n> 的提交是「PR 合进当时的 product」，它的父提交是公开 main（修之前的代码）。
//   node scripts/ci/red-check.mjs plan <修之前的提交> <PR 的提交> <输出.json>   要跑哪些测试文件（前端：vitest 认的那些，删掉的不算）
//   node scripts/ci/red-check.mjs judge <plan.json> <vitest 的 json 报告> <输出.json>   结论；报告没有（vitest 没跑起来）也能判
// 结论（verdict）：
//   red     至少一个新测试在修之前的代码上失败 → 过
//   green   新测试在修之前的代码上全都通过 → 没测到这次的改动（打开拦截以后这是唯一不过的）
//   unknown 核对不了：测试文件在旧代码上加载不了（要的模块、函数还不存在，新功能常见）、vitest 没跑起来 → 不拦
//   none    没有新的前端测试（纯样式、文案、只改 Rust 的）→ 不拦；Rust 的测试第 2 步再核对
// 只要求至少一个变红：执行员常加几个「别的行为没变」的测试，它们在旧代码上本来就该绿。加载不了不算红：不然写坏的测试也能混过去。
//
// 这个脚本和 red-check.yml 执行员不许改（.cowork/autopilot/policy.yml 的 executor_forbidden：scripts/ci/**、.github/**），
// 所以直接用 PR 那份；跑的测试是 PR 的代码，这一格不带任何 secret（报结果在另一个 job）。
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

// vitest.config.ts 的 include（改了那边这里一起改）
export const VITEST_TEST = [
  /^src\/.+\.(test|spec)\.(ts|tsx)$/,
  /^browser-agent\/.+\.(test|spec)\.ts$/,
]
// Rust 的测试：第 2 步再核对，现在只数一下（描述里写「Rust 的测试还不核对」）
export const RUST_SRC = /^src-tauri\/.+\.rs$/

// git diff --name-status 的输出 → { vitest: [新加、改过的测试文件], rust: [改过的 .rs] }。删掉的、改名前的路径不算
export function planFrom(nameStatus) {
  const vitest = []
  const rust = []
  for (const line of String(nameStatus || "").split("\n")) {
    const parts = line.split("\t")
    const status = parts[0] || ""
    if (!status || status.startsWith("D")) continue
    const file = parts[parts.length - 1]
    if (VITEST_TEST.some((re) => re.test(file))) vitest.push(file)
    else if (RUST_SRC.test(file)) rust.push(file)
  }
  return { vitest, rust }
}

// 失败是断言没对上（assert：期望和实际、找不到界面上的东西），还是测试自己撞上了错（error：要的函数、文案还不存在）。
// 两种都算红（新测试在旧代码上过不了）；只记录的那几天看比例，判断「红」是不是大多真的在测行为
export function failKind(msg) {
  const m = String(msg || "")
  return /AssertionError|expected .* (to|not)|Expected|Received|Unable to find|toHaveBeenCalled|toBeInTheDocument/.test(
    m
  )
    ? "assert"
    : "error"
}

const firstLine = (s, n = 160) =>
  String(s || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim()
    .split("\n")[0]
    .slice(0, n)

// vitest --reporter=json 的报告 → 结论。report 是 null：vitest 没跑起来或没写报告
export function judge(plan, report) {
  const files = plan?.vitest || []
  const rustNote = plan?.rust?.length ? "；Rust 的测试还不核对" : ""
  if (!files.length)
    return {
      verdict: "none",
      red: [],
      loadErrors: [],
      passed: 0,
      text: `没有新的前端测试${rustNote}`,
    }
  if (!report || !Array.isArray(report.testResults))
    return {
      verdict: "unknown",
      red: [],
      loadErrors: [],
      passed: 0,
      text: `核对不了：vitest 在修之前的代码上没跑起来${rustNote}`,
    }
  const red = []
  const loadErrors = []
  let passed = 0
  for (const f of report.testResults) {
    const rel = relPath(f.name, files)
    const asserts = f.assertionResults || []
    const failed = asserts.filter((a) => a.status === "failed")
    passed += asserts.filter((a) => a.status === "passed").length
    for (const a of failed)
      red.push({
        file: rel,
        test: a.fullName || a.title || "",
        why: firstLine((a.failureMessages || [])[0]),
        kind: failKind((a.failureMessages || [])[0]),
      })
    // 整个文件没跑起来（import 的模块不存在、语法错）：status failed、一个测试都没失败，原因在 message 里
    if (f.status === "failed" && !failed.length)
      loadErrors.push({ file: rel, why: firstLine(f.message) || "加载不了" })
  }
  // 报告里没有的文件（vitest 没认出来）也算加载不了
  for (const file of files) {
    if (!report.testResults.some((f) => relPath(f.name, files) === file))
      loadErrors.push({ file, why: "vitest 没跑这个文件" })
  }
  const asserts = red.filter((r) => r.kind === "assert").length
  const how =
    asserts === red.length
      ? "都是断言没对上"
      : asserts
        ? `${asserts} 个是断言没对上`
        : "都是撞上了错（要的代码还不存在）"
  if (red.length)
    return {
      verdict: "red",
      red,
      loadErrors,
      passed,
      text: `红了：${red.length} 个测试在修之前的代码上失败（${how}）${rustNote}`,
    }
  if (loadErrors.length)
    return {
      verdict: "unknown",
      red,
      loadErrors,
      passed,
      text: `核对不了：${loadErrors.length} 个测试文件在修之前的代码上加载不了（多半是要的代码还不存在）${rustNote}`,
    }
  return {
    verdict: "green",
    red,
    loadErrors,
    passed,
    text: `全绿：${passed} 个测试在修之前的代码上也都通过，没测到这次的改动${rustNote}`,
  }
}

// 报告里是绝对路径：对回 plan 里的相对路径
function relPath(abs, files) {
  const a = String(abs || "")
  return files.find((f) => a === f || a.endsWith(`/${f}`)) || a
}

// GitHub 的 commit status 描述最多 140 字
export function statusOf(result, mode) {
  const block = mode === "on" && result.verdict === "green"
  const prefix = mode === "on" ? "" : "（只记录）"
  return {
    state: block ? "failure" : "success",
    description: `${prefix}${result.text}`.slice(0, 140),
  }
}

// step summary：结论 + 失败的、加载不了的前几个
export function summary(result, mode) {
  const lines = [
    `### 先红核对${mode === "on" ? "" : "（只记录，不挡合并）"}`,
    "",
    result.text,
    "",
  ]
  if (result.red.length)
    lines.push(
      "在修之前的代码上失败的：",
      ...result.red
        .slice(0, 10)
        .map(
          (r) =>
            `- 〔${r.kind === "assert" ? "断言" : "出错"}〕\`${r.file}\` ${r.test}：${r.why}`
        ),
      ""
    )
  if (result.loadErrors.length)
    lines.push(
      "加载不了的：",
      ...result.loadErrors.slice(0, 10).map((r) => `- \`${r.file}\`：${r.why}`),
      ""
    )
  return lines.join("\n")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...a] = process.argv.slice(2)
  if (cmd === "plan") {
    const [base, head, out] = a
    const ns = execFileSync(
      "git",
      ["diff", "--name-status", "--no-renames", base, head],
      { encoding: "utf8" }
    )
    const plan = planFrom(ns)
    writeFileSync(out, JSON.stringify(plan))
    console.log(
      `前端测试 ${plan.vitest.length} 个：${plan.vitest.join(" ") || "（没有）"}；改了的 Rust 文件 ${plan.rust.length} 个`
    )
  } else if (cmd === "judge") {
    const [planFile, reportFile, out] = a
    const plan = JSON.parse(readFileSync(planFile, "utf8"))
    let report = null
    try {
      if (existsSync(reportFile))
        report = JSON.parse(readFileSync(reportFile, "utf8"))
    } catch {
      report = null
    }
    const result = judge(plan, report)
    const mode = process.env.RED_CHECK_MODE === "on" ? "on" : "record"
    writeFileSync(out, JSON.stringify({ ...result, ...statusOf(result, mode) }))
    if (process.env.GITHUB_STEP_SUMMARY)
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary(result, mode), {
        flag: "a",
      })
    console.log(result.text)
  } else {
    console.error(`不认识的命令：${cmd}`)
    process.exit(2)
  }
}
