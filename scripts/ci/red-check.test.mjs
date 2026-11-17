// node --test scripts/ci/ 跑（公开 CI 的 Workflow lint 那一格）
import assert from "node:assert/strict"
import { test } from "node:test"
import { failKind, judge, planFrom, statusOf, summary } from "./red-check.mjs"

test("plan：只要新加、改过的 vitest 测试文件，删掉的不算；改了的 Rust 只数一下", () => {
  const ns = [
    "M\tsrc/components/a.test.tsx",
    "A\tsrc/lib/b.test.ts",
    "D\tsrc/lib/gone.test.ts",
    "M\tsrc/lib/b.ts",
    "A\tbrowser-agent/c.spec.ts",
    "M\tsrc-tauri/src/web/x.rs",
    "M\tscripts/ci/x.test.mjs",
    "M\tsrc-tauri/src/lib.test.ts",
  ].join("\n")
  assert.deepEqual(planFrom(ns), {
    vitest: [
      "src/components/a.test.tsx",
      "src/lib/b.test.ts",
      "browser-agent/c.spec.ts",
    ],
    rust: ["src-tauri/src/web/x.rs"],
  })
  assert.deepEqual(planFrom(""), { vitest: [], rust: [] })
})

const plan = { vitest: ["src/a.test.ts", "src/b.test.tsx"], rust: [] }
const file = (name, status, asserts, message = "") => ({
  name: `/home/runner/work/x/x/${name}`,
  status,
  message,
  assertionResults: asserts,
})
const t = (fullName, status, msg) => ({
  fullName,
  status,
  failureMessages: msg ? [msg] : [],
})

test("红：有一个新测试在旧代码上失败就算红，其余的绿是正常的；分得出断言没对上和撞上错", () => {
  const r = judge(plan, {
    testResults: [
      file("src/a.test.ts", "failed", [
        t(
          "a shows retry",
          "failed",
          "AssertionError: expected false to be true\n    at x"
        ),
        t("a keeps old", "passed"),
      ]),
      file("src/b.test.tsx", "failed", [
        t(
          "b label",
          "failed",
          "Error: It looks like undefined was passed instead of a matcher."
        ),
      ]),
    ],
  })
  assert.equal(r.verdict, "red")
  assert.deepEqual(
    r.red.map((x) => [x.file, x.kind]),
    [
      ["src/a.test.ts", "assert"],
      ["src/b.test.tsx", "error"],
    ]
  )
  assert.match(
    r.text,
    /^红了：2 个测试在修之前的代码上失败（1 个是断言没对上）$/
  )
  assert.equal(
    failKind(
      "TestingLibraryElementError: Unable to find an element with the text: 重试"
    ),
    "assert"
  )
  assert.equal(failKind("TypeError: retry is not a function"), "error")
})

test("全绿：新测试在旧代码上都通过 → 没测到这次的改动；只有打开拦截（on）才是 failure", () => {
  const r = judge(plan, {
    testResults: [
      file("src/a.test.ts", "passed", [t("a", "passed")]),
      file("src/b.test.tsx", "passed", [t("b1", "passed"), t("b2", "passed")]),
    ],
  })
  assert.equal(r.verdict, "green")
  assert.match(r.text, /^全绿：3 个测试在修之前的代码上也都通过/)
  assert.deepEqual(statusOf(r, "record"), {
    state: "success",
    description: `（只记录）${r.text}`,
  })
  assert.equal(statusOf(r, "on").state, "failure")
})

test("核对不了：文件加载不了（要的模块还不存在）、报告里没有、vitest 没跑起来；加载不了的不算红", () => {
  const load = judge(plan, {
    testResults: [
      file(
        "src/a.test.ts",
        "failed",
        [],
        'Failed to resolve import "./b" from "src/a.test.ts". Does the file exist?'
      ),
      file("src/b.test.tsx", "passed", [t("b", "passed")]),
    ],
  })
  assert.equal(load.verdict, "unknown")
  assert.deepEqual(
    load.loadErrors.map((x) => x.file),
    ["src/a.test.ts"]
  )
  assert.equal(statusOf(load, "on").state, "success")
  const missing = judge(plan, {
    testResults: [file("src/a.test.ts", "passed", [t("a", "passed")])],
  })
  assert.deepEqual(
    [missing.verdict, missing.loadErrors[0]],
    ["unknown", { file: "src/b.test.tsx", why: "vitest 没跑这个文件" }]
  )
  assert.match(judge(plan, null).text, /vitest 在修之前的代码上没跑起来/)
})

test("没有新的前端测试：不拦；改了 Rust 的写一句还不核对；描述不超过 140 字", () => {
  assert.equal(judge({ vitest: [], rust: [] }, null).text, "没有新的前端测试")
  const r = judge({ vitest: [], rust: ["src-tauri/src/a.rs"] }, null)
  assert.deepEqual(
    [r.verdict, r.text],
    ["none", "没有新的前端测试；Rust 的测试还不核对"]
  )
  const long = { ...r, text: "长".repeat(300) }
  assert.equal(statusOf(long, "record").description.length, 140)
  assert.match(
    summary(
      {
        ...r,
        red: [{ file: "a", test: "t", why: "w", kind: "assert" }],
        loadErrors: [],
      },
      "record"
    ),
    /只记录，不挡合并[\s\S]*〔断言〕`a` t：w/
  )
})
