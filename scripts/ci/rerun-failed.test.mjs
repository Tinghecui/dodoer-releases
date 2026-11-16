// node --test scripts/ci/*.test.mjs 跑（公开 CI 的 Workflow lint 那一格）
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  badCommands,
  excerpt,
  missingPasses,
  plan,
  stripAnsi,
} from "./rerun-failed.mjs"

const SCRIPT = fileURLToPath(new URL("./rerun-failed.mjs", import.meta.url))
const red = (s) => `\u001b[31m${s}\u001b[39m`
const bar = (title) => red(`⎯⎯⎯⎯⎯⎯⎯ ${title} ⎯⎯⎯⎯⎯⎯⎯`)

// vitest 4 默认报告器在 GitHub Actions 上的输出（带颜色；照 2026-11-16 本机 GITHUB_ACTIONS=true 跑出来的样子）
function vitestReport(
  names,
  { suites = [], unhandled = false, failed = names.length } = {}
) {
  return [
    " RUN  v4.1.11 /repo",
    "",
    " ❯ src/lib/a.test.ts (3 tests | 1 failed) 17ms",
    "     × fails sometimes 9ms",
    "",
    ...(suites.length
      ? [
          bar(`Failed Suites ${suites.length}`),
          "",
          ...suites.map((file) => ` FAIL  ${file} [ ${file} ]`),
          "Error: module load failed",
          "",
        ]
      : []),
    bar(`Failed Tests ${names.length}`),
    "",
    ...names.flatMap((name) => [
      `\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m ${name.replaceAll(" > ", "\u001b[2m > \u001b[22m")}`,
      "AssertionError: expected 1 to be 2 // Object.is equality",
      "",
      ` ❯ ${name.split(" > ")[0]}:8:44`,
      red("⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯"),
      "",
    ]),
    ...(unhandled
      ? [
          bar("Unhandled Errors"),
          "Vitest caught 1 unhandled error during the test run.",
        ]
      : []),
    `\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m (4)`,
    `\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m${failed} failed\u001b[39m\u001b[22m | 9 passed (${failed + 9})`,
    ...(unhandled ? ["     Errors  1 error"] : []),
    "::error file=/repo/src/lib/a.test.ts,title=src/lib/a.test.ts > group > flaky case,line=8,column=44::AssertionError",
  ].join("\n")
}

// 重跑时的 --reporter=verbose：每条用例一行
const verbose = (lines) =>
  lines.map((l) => `\u001b[32m✓\u001b[39m ${l}`).join("\n")

const FLAKY = "src/lib/a.test.ts > group > flaky case"

test("颜色去掉", () => {
  assert.equal(
    stripAnsi("\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m x"),
    " FAIL  x"
  )
})

test("vitest：挂了一条认得清的 → 重跑它所在的文件", () => {
  const p = plan("vitest", vitestReport([FLAKY]))
  assert.equal(p.rerun, true)
  assert.deepEqual(p.names, [FLAKY])
  assert.deepEqual(p.args, ["src/lib/a.test.ts"])
})

test("vitest：两个文件里挂了三条 → 两个文件各重跑一次", () => {
  const names = [
    FLAKY,
    "src/lib/a.test.ts > group > second",
    "src/b.test.tsx > b > slow",
  ]
  const p = plan("vitest", vitestReport(names))
  assert.equal(p.rerun, true)
  assert.deepEqual(p.names, names)
  assert.deepEqual(p.args, ["src/lib/a.test.ts", "src/b.test.tsx"])
})

for (const [why, output, reason] of [
  [
    "有整个文件没跑起来",
    vitestReport([FLAKY], { suites: ["src/broken.test.ts"] }),
    /Failed Suites/,
  ],
  [
    "有测试以外抛出的错误",
    vitestReport([FLAKY], { unhandled: true }),
    /Unhandled Errors/,
  ],
  ["汇总数对不上", vitestReport([FLAKY], { failed: 2 }), /对不上/],
  [
    "认不出挂掉的用例",
    "Error: Failed to load config from vitest.config.ts",
    /认不出/,
  ],
  [
    "文件名不能直接拼进命令",
    vitestReport(["src/a b.test.ts > group > case"]),
    /字符/,
  ],
  [
    "挂了超过 3 条",
    vitestReport(["a", "b", "c", "d"].map((t) => `src/x.test.ts > ${t}`)),
    /4 条，超过 3 条/,
  ],
]) {
  test(`vitest：${why} → 不重跑`, () => {
    const p = plan("vitest", output)
    assert.equal(p.rerun, false)
    assert.match(p.reason, reason)
  })
}

test("vitest：重跑输出里每条都要有 ✓，名字只是开头一样的不算", () => {
  const out = verbose([
    "src/lib/a.test.ts > group > other 1ms",
    `${FLAKY} 3ms`,
    "src/lib/a.test.ts > group > slow one 1234ms (retry x1)",
  ])
  assert.deepEqual(missingPasses("vitest", out, [FLAKY]), [])
  assert.deepEqual(
    missingPasses("vitest", out, ["src/lib/a.test.ts > group > slow one"]),
    []
  )
  assert.deepEqual(
    missingPasses("vitest", verbose([`${FLAKY} two 1ms`]), [FLAKY]),
    [FLAKY]
  )
  assert.deepEqual(missingPasses("vitest", ` × ${FLAKY} 3ms`, [FLAKY]), [FLAKY])
  // 名字里有正则的特殊字符
  const odd = "src/x.test.ts > parses (a|b) + [c]"
  assert.deepEqual(missingPasses("vitest", verbose([`${odd} 0ms`]), [odd]), [])
})

test("vitest：第一次的报错摘出来（到下一条分隔线为止）", () => {
  const text = excerpt("vitest", vitestReport([FLAKY]), FLAKY)
  assert.match(text, /^FAIL {2}src\/lib\/a\.test\.ts > group > flaky case/)
  assert.match(text, /AssertionError/)
  assert.doesNotMatch(text, /⎯/)
  assert.equal(excerpt("vitest", "nothing", FLAKY), "")
})

test("命令不对就不跑", () => {
  const ok = "pnpm vitest run --reporter=verbose"
  assert.equal(badCommands("vitest", "pnpm vitest run --shard=1/6", ok), "")
  assert.match(badCommands("vitest", "pnpm vitest run --bail=1", ok), /--bail/)
  assert.match(
    badCommands("vitest", "pnpm vitest run", "pnpm vitest run"),
    /--reporter=verbose/
  )
  assert.match(
    badCommands("vitest", "pnpm vitest run", `${ok} --shard=1/6`),
    /--shard/
  )
  assert.match(badCommands("jest", "a", "b"), /不认识/)
})

// 整个脚本：假的测试命令把准备好的输出打出来
function runScript(t, kind, { first, firstCode = 1, rerun, rerunCode = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "rerun-failed-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "first.txt"), `${first}\n`)
  writeFileSync(join(dir, "rerun.txt"), `${rerun ?? ""}\n`)
  const summary = join(dir, "summary.md")
  const args = join(dir, "args.txt")
  const flags =
    kind === "vitest" ? "--reporter=verbose" : "--no-fail-fast -- --exact"
  const res = spawnSync(
    process.execPath,
    [
      SCRIPT,
      kind,
      "Frontend vitest (1/6)",
      `cat '${join(dir, "first.txt")}'; exit ${firstCode} # --no-fail-fast`,
      `f() { echo "$*" > '${args}'; cat '${join(dir, "rerun.txt")}'; exit ${rerunCode}; }; f ${flags}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    }
  )
  const read = (f) => {
    try {
      return readFileSync(f, "utf8")
    } catch {
      return null
    }
  }
  return { ...res, summary: read(summary), args: read(args) }
}

test("脚本：第一次过了就直接过，不写 summary", (t) => {
  const r = runScript(t, "vitest", { first: "all good", firstCode: 0 })
  assert.equal(r.status, 0)
  assert.equal(r.summary, null)
  assert.equal(r.args, null)
})

test("脚本：vitest 挂一条、重跑过了 → 放行，留 ::warning 和 summary", (t) => {
  const r = runScript(t, "vitest", {
    first: vitestReport([FLAKY]),
    rerun: verbose([`${FLAKY} 3ms`, "src/lib/a.test.ts > group > other 1ms"]),
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.args.trim(), "--reporter=verbose src/lib/a.test.ts")
  assert.match(
    r.stdout,
    /^::warning file=src\/lib\/a\.test\.ts,title=偶发失败，重跑才过::Frontend vitest \(1\/6\)：src\/lib\/a\.test\.ts > group > flaky case 第一次没过/m
  )
  assert.match(
    r.stdout,
    /^RERUN PASS Frontend vitest \(1\/6\): src\/lib\/a\.test\.ts > group > flaky case$/m
  )
  assert.match(r.summary, /单独重跑过了/)
  assert.match(
    r.summary,
    /\| `src\/lib\/a\.test\.ts > group > flaky case` \| 过了 \|/
  )
  assert.match(r.summary, /AssertionError/)
})

test("脚本：重跑还挂 → 红，退出码照重跑的", (t) => {
  const r = runScript(t, "vitest", {
    first: vitestReport([FLAKY]),
    rerun: ` × ${FLAKY} 3ms`,
    rerunCode: 1,
  })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^RERUN FAIL /m)
  assert.doesNotMatch(r.stdout, /::warning/)
  assert.match(r.summary, /还是没过/)
  assert.match(r.summary, /\| 没过 \|/)
})

test("脚本：重跑退出 0 但没看到那条的 ✓ → 红", (t) => {
  const r = runScript(t, "vitest", {
    first: vitestReport([FLAKY]),
    rerun: verbose(["src/lib/a.test.ts > group > other 1ms"]),
  })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^RERUN NOT RUN /m)
  assert.match(r.summary, /没跑到/)
})

test("脚本：不该重跑的照第一次的退出码红，summary 写原因", (t) => {
  const r = runScript(t, "vitest", {
    first: vitestReport([FLAKY], { unhandled: true }),
    firstCode: 3,
  })
  assert.equal(r.status, 3)
  assert.equal(r.args, null)
  assert.match(
    r.stdout,
    /^RERUN SKIP Frontend vitest \(1\/6\): .*Unhandled Errors/m
  )
  assert.match(r.summary, /没有单独重跑/)
})

test("脚本：参数不对 → 退出码 2，什么都不跑", (t) => {
  const missing = spawnSync(process.execPath, [SCRIPT, "vitest"], {
    encoding: "utf8",
  })
  assert.equal(missing.status, 2)
  const dir = mkdtempSync(join(tmpdir(), "rerun-failed-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const marker = join(dir, "ran")
  const bail = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "vitest",
      "x",
      `touch '${marker}'; vitest run --bail=1`,
      "vitest run --reporter=verbose",
    ],
    { encoding: "utf8" }
  )
  assert.equal(bail.status, 2)
  assert.match(bail.stderr, /--bail/)
  assert.throws(() => readFileSync(marker))
})

// cargo test --no-fail-fast 的输出：stdout 是 libtest 的，stderr 是 cargo 的（CI 上 CARGO_TERM_COLOR=always，带颜色）
const cargoErr = (s) =>
  `\u001b[1m\u001b[91merror\u001b[0m\u001b[1m:\u001b[0m ${s}`
const SSHD = "host_ssh::sshd::tests::the_service_starts"
function libtestTarget(failed, { passed = 2, crash = false } = {}) {
  const lines = [
    "",
    `running ${failed.length + passed} tests`,
    ...Array.from({ length: passed }, (_, i) => `test ok::case_${i} ... ok`),
    ...failed.map((n) => `test ${n} ... FAILED`),
  ]
  if (crash) return lines
  if (!failed.length)
    return [
      ...lines,
      "",
      `test result: ok. ${passed} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s`,
    ]
  return [
    ...lines,
    "",
    "failures:",
    "",
    ...failed.flatMap((n) => [
      `---- ${n} stdout ----`,
      "",
      `thread '${n}' panicked at src/x.rs:10:5:`,
      "assertion failed: ready",
      "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
      "",
    ]),
    "",
    "failures:",
    ...failed.map((n) => `    ${n}`),
    "",
    `test result: FAILED. ${passed} passed; ${failed.length} failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s`,
  ]
}
// targets：[{ failed: [名字…], crash?, arg }]
function cargoReport(targets, { summary = true } = {}) {
  const stdout = targets.flatMap((t) => libtestTarget(t.failed, t))
  const bad = targets.filter((t) => t.failed.length || t.crash)
  const stderr = [
    ...targets.flatMap((t) => [
      `\u001b[1m\u001b[92m     Running\u001b[0m unittests ${t.arg} (target/debug/deps/x-0123)`,
      ...(t.failed.length || t.crash
        ? [cargoErr(`test failed, to rerun pass \`${t.arg}\``)]
        : []),
      ...(t.crash
        ? [
            "",
            "Caused by:",
            "  process didn't exit successfully: `target/debug/deps/x-0123` (signal: 6, SIGABRT: process abort signal)",
          ]
        : []),
    ]),
    ...(summary && bad.length
      ? [
          cargoErr(`${bad.length} target${bad.length > 1 ? "s" : ""} failed:`),
          ...bad.map((t) => `    \`${t.arg}\``),
        ]
      : []),
  ]
  return `${stdout.join("\n")}\n${stderr.join("\n")}`
}
const lib = (failed, more) => ({ failed, arg: "--lib", ...more })
const bin = (failed, more) => ({
  failed,
  arg: "--bin codeg-server",
  ...more,
})

test("cargo：lib 挂了一条、bin 都过 → 重跑那一条", () => {
  const p = plan("libtest", cargoReport([lib([SSHD]), bin([])]))
  assert.equal(p.rerun, true)
  assert.deepEqual(p.names, [SSHD])
  assert.deepEqual(p.args, [SSHD])
})

test("cargo：两个测试程序各挂一条 → 两条一起重跑", () => {
  const p = plan("libtest", cargoReport([lib([SSHD]), bin(["tests::boot"])]))
  assert.equal(p.rerun, true)
  assert.deepEqual(p.names, [SSHD, "tests::boot"])
})

for (const [why, output, reason] of [
  [
    "编译没过",
    cargoErr("could not compile `codeg` (lib test) due to 1 previous error"),
    /认不出/,
  ],
  [
    "有测试程序崩了（只有 error 那行，没有 test result）",
    cargoReport([lib([], { crash: true }), bin(["tests::boot"])]),
    /崩/,
  ],
  [
    "有认不出名字的失败（should panic 的写法）",
    cargoReport([lib([SSHD])]).replace(
      "test result: FAILED. 2 passed; 1 failed;",
      "test result: FAILED. 1 passed; 2 failed;"
    ),
    /对不上/,
  ],
  [
    "挂了超过 3 条",
    cargoReport([lib(["a::one", "a::two", "a::three", "a::four"])]),
    /4 条，超过 3 条/,
  ],
  [
    "测试名里有不能直接拼进命令的字符",
    cargoReport([lib(["a::b$(true)"])]),
    /字符/,
  ],
]) {
  test(`cargo：${why} → 不重跑`, () => {
    const p = plan("libtest", output)
    assert.equal(p.rerun, false)
    assert.match(p.reason, reason)
  })
}

test("cargo：结尾没有 N targets failed 那行也行（只在有的时候核对）", () => {
  assert.equal(
    plan("libtest", cargoReport([lib([SSHD])], { summary: false })).rerun,
    true
  )
})

test("cargo：重跑输出里要有 `test 名字 ... ok`，名字只是开头一样的不算", () => {
  const out = libtestTarget([], { passed: 0 })
    .concat([`test ${SSHD} ... ok`, "test result: ok. 1 passed; 0 failed;"])
    .join("\n")
  assert.deepEqual(missingPasses("libtest", out, [SSHD]), [])
  assert.deepEqual(
    missingPasses("libtest", `test ${SSHD}_twice ... ok`, [SSHD]),
    [SSHD]
  )
  assert.deepEqual(
    missingPasses("libtest", `test ${SSHD} ... FAILED`, [SSHD]),
    [SSHD]
  )
})

test("cargo：第一次的报错摘 `---- 名字 stdout ----` 那一段", () => {
  const text = excerpt("libtest", cargoReport([lib([SSHD, "a::other"])]), SSHD)
  assert.match(
    text,
    /^---- host_ssh::sshd::tests::the_service_starts stdout ----/
  )
  assert.match(text, /assertion failed: ready/)
  assert.doesNotMatch(text, /a::other/)
})

test("cargo 的命令：要 --no-fail-fast，重跑要以 --exact 结尾", () => {
  const rerun = "cargo test --lib --no-fail-fast -- --exact"
  assert.equal(
    badCommands("libtest", "cargo test --lib --no-fail-fast", rerun),
    ""
  )
  assert.match(
    badCommands("libtest", "cargo test --lib", rerun),
    /--no-fail-fast/
  )
  assert.match(
    badCommands("libtest", "cargo test --lib --no-fail-fast", "cargo test"),
    /--exact/
  )
})

test("脚本：cargo 挂一条、重跑过了 → 放行，名字拼在 --exact 后面，注解不带 file", (t) => {
  const r = runScript(t, "libtest", {
    first: cargoReport([lib([SSHD]), bin([])]),
    firstCode: 101,
    rerun: [
      "",
      "running 1 test",
      `test ${SSHD} ... ok`,
      "",
      "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 7115 filtered out; finished in 0.20s",
    ].join("\n"),
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.args.trim(), `--no-fail-fast -- --exact ${SSHD}`)
  assert.match(
    r.stdout,
    new RegExp(
      `^::warning title=偶发失败，重跑才过::.*：${SSHD} 第一次没过`,
      "m"
    )
  )
  assert.match(r.summary, /assertion failed: ready/)
})

test("脚本：cargo 重跑还挂 → 红，退出码照重跑的", (t) => {
  const r = runScript(t, "libtest", {
    first: cargoReport([lib([SSHD])]),
    firstCode: 101,
    rerun: cargoReport([lib([SSHD])]),
    rerunCode: 101,
  })
  assert.equal(r.status, 101)
  assert.match(r.stdout, /^RERUN FAIL /m)
})
