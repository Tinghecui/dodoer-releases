// node --test scripts/desktop-e2e/ledger.test.mjs（公开 CI 的 Workflow lint 一格跟 scripts/ci 的测试一起跑）
import assert from "node:assert/strict"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  apply,
  evaluate,
  loadMap,
  loadResults,
  machineOf,
  push,
} from "./ledger.mjs"

const here = fileURLToPath(new URL(".", import.meta.url))
const source = {
  update: readFileSync(join(here, "update", "run.mjs"), "utf8"),
  native: readFileSync(join(here, "native", "run.mjs"), "utf8"),
  dom: readdirSync(join(here, "specs"))
    .map((f) => readFileSync(join(here, "specs", f), "utf8"))
    .join("\n"),
}

test("ledger-map.json：每一步的原文在对应的 spec 里真有，编号、字段都对", () => {
  const map = loadMap()
  assert.ok(Object.keys(map).length > 0)
  for (const [id, t] of Object.entries(map)) {
    assert.match(id, /^(PR\d+|[A-Z]\d+)$/, id)
    assert.ok(
      t.note && t.note.length <= 200,
      `${id} 的 note 要有、不超过 200 字`
    )
    assert.ok(Array.isArray(t.checks) && t.checks.length, `${id} 没有 checks`)
    assert.ok(Array.isArray(t.human), `${id} 的 human 要是数组`)
    for (const c of t.checks) {
      assert.ok(source[c.suite] != null, `${id}：没有 suite ${c.suite}`)
      assert.ok(
        !c.machine || ["macos-arm64", "macos-x64", "linux"].includes(c.machine),
        `${id}：machine ${c.machine}`
      )
      assert.ok(!/\$\{/.test(c.step), `${id}：step 里不能带 \${…}`)
      assert.ok(
        source[c.suite].includes(c.step),
        `${id}：${c.suite} 里找不到步骤「${c.step}」，改了步骤名要跟着改 ledger-map.json`
      )
    }
  }
})

test("machineOf 认 artifact 目录名", () => {
  assert.equal(
    machineOf("desktop-e2e-45022414504-macos-15-intel-attempt1"),
    "macos-x64"
  )
  assert.equal(
    machineOf("desktop-e2e-45022414504-macos-15-attempt2"),
    "macos-arm64"
  )
  assert.equal(machineOf("desktop-e2e-out-ubuntu-22.04-attempt1"), "linux")
  assert.equal(machineOf("something-else"), "")
})

const step = (name, ok = true, detail = "") => ({
  phase: "A",
  name,
  ok,
  seconds: 1,
  detail,
})
const map = {
  PR1: {
    note: "一",
    checks: [{ suite: "update", phase: "A", step: "甲" }],
    human: [],
  },
  PR2: {
    note: "二",
    checks: [{ suite: "update", phase: "A", step: "乙" }],
    human: ["人验"],
  },
  PR3: {
    note: "三",
    checks: [{ suite: "update", phase: "A", machine: "macos-x64", step: "甲" }],
    human: [],
  },
  N9: {
    note: "故事",
    checks: [
      { suite: "update", phase: "A", step: "甲" },
      { suite: "update", phase: "A", step: "乙" },
    ],
    human: [],
  },
}

test("loadResults：每台机器取最后一次 attempt；evaluate：pass / partial / 这次没有的不记", () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-ledger-test-"))
  const put = (dir, steps) => {
    mkdirSync(join(root, dir, "update"), { recursive: true })
    writeFileSync(
      join(root, dir, "update", "result-update.json"),
      JSON.stringify({ phase: "update", steps })
    )
  }
  put("desktop-e2e-1-macos-15-attempt1", [
    step("甲", false, "坏了"),
    step("乙"),
  ])
  put("desktop-e2e-1-macos-15-attempt2", [step("甲"), step("乙")])
  writeFileSync(
    join(root, "desktop-e2e-1-macos-15-attempt2", "result-phase1.json"),
    JSON.stringify({ steps: [{ name: "开窗口", ok: true, seconds: 1 }] })
  )
  const results = loadResults(root)
  assert.equal(results.filter((r) => r.suite === "update").length, 2)
  assert.deepEqual(
    results.find((r) => r.suite === "dom"),
    {
      machine: "macos-arm64",
      suite: "dom",
      phase: "1",
      name: "开窗口",
      ok: true,
      detail: "",
    }
  )
  const rows = Object.fromEntries(evaluate(results, map).map((r) => [r.id, r]))
  assert.equal(rows.PR1.verdict, "pass")
  assert.equal(rows.PR2.verdict, "partial")
  assert.deepEqual(rows.PR2.human, ["人验"])
  assert.equal(rows.PR3, undefined, "没跑 Intel 的不记")
  assert.equal(rows.N9.verdict, "pass")
  assert.deepEqual(rows.N9.machines, ["macos-arm64"])
})

test("evaluate：没过记 fail（不带 human），前面挂了没跑的记 blocked，Linux 的不算 macOS", () => {
  const r = (machine, name, ok, detail) => ({
    machine,
    suite: "update",
    phase: "A",
    name,
    ok,
    detail: detail || "",
  })
  const rows = Object.fromEntries(
    evaluate(
      [
        r("macos-arm64", "甲 x", false, "超时"),
        r("macos-arm64", "乙 y", false, "没跑：前面「甲」没过"),
        r("linux", "甲", true),
      ],
      map
    ).map((x) => [x.id, x])
  )
  assert.equal(rows.PR1.verdict, "fail")
  assert.match(rows.PR1.notes, /没过：甲 x（macos-arm64）/)
  assert.equal(rows.PR2.verdict, "blocked")
  assert.deepEqual(rows.PR2.human, ["人验"])
  assert.equal(rows.N9.verdict, "fail")
  assert.deepEqual(rows.N9.machines, ["macos-arm64"])
})

test("push：最新一条是 mac-e2e 且结论一样时原地换，否则加在前面，留 4 条", () => {
  const mac = { env: "mac", verdict: "needs_human", date: "d0" }
  let list = push([mac], { env: "mac-e2e", verdict: "pass", date: "d1" })
  assert.deepEqual(
    list.map((e) => e.date),
    ["d1", "d0"]
  )
  list = push(list, { env: "mac-e2e", verdict: "pass", date: "d2" })
  assert.deepEqual(
    list.map((e) => e.date),
    ["d2", "d0"]
  )
  list = push(list, { env: "mac-e2e", verdict: "fail", date: "d3" })
  assert.deepEqual(
    list.map((e) => e.date),
    ["d3", "d2", "d0"]
  )
  list = push([{ env: "mac", verdict: "pass" }, ...list], {
    env: "mac-e2e",
    verdict: "pass",
    date: "d4",
  })
  assert.equal(list.length, 4)
  assert.equal(list[0].date, "d4")
})

test('apply：PR 记进 changes（env mac-e2e、保留标题），故事记进 stories[id]["mac-e2e"]，测试员的 mac 不动', () => {
  const ledger = {
    changes: {
      PR2: [
        { env: "mac", verdict: "needs_human", title: "标题", human: ["旧"] },
      ],
    },
    stories: {
      N9: {
        mac: {
          last: { verdict: "needs_human" },
          history: [{ verdict: "needs_human" }],
        },
      },
    },
    runs: [{ env: "mac" }],
  }
  const rows = [
    {
      id: "PR2",
      verdict: "partial",
      notes: "二",
      human: ["人验"],
      machines: ["macos-arm64"],
      steps: 1,
    },
    {
      id: "N9",
      verdict: "pass",
      notes: "故事",
      human: [],
      machines: ["macos-arm64", "macos-x64"],
      steps: 2,
    },
  ]
  apply(ledger, rows, {
    version: "desktop-e2e@abc1234",
    date: "2026-11-22",
    run: "42",
    runUrl: "https://example.invalid/run/42",
  })
  const e = ledger.changes.PR2[0]
  assert.equal(e.env, "mac-e2e")
  assert.equal(e.verdict, "partial")
  assert.equal(e.title, "标题")
  assert.deepEqual(e.human, ["人验"])
  assert.equal(e.notes, "二。desktop-e2e run 42（macos-arm64，1 步）")
  assert.equal(ledger.changes.PR2[1].env, "mac")
  assert.equal(ledger.stories.N9.mac.last.verdict, "needs_human")
  assert.equal(ledger.stories.N9["mac-e2e"].last.verdict, "pass")
  assert.equal(ledger.stories.N9["mac-e2e"].last.env, undefined)
  assert.equal(ledger.stories.N9["mac-e2e"].history.length, 1)
  apply(ledger, rows, {
    version: "desktop-e2e@def5678",
    date: "2026-11-23",
    run: "43",
  })
  assert.equal(
    ledger.stories.N9["mac-e2e"].history.length,
    1,
    "结论没变：原地换"
  )
  assert.equal(ledger.stories.N9["mac-e2e"].last.version, "desktop-e2e@def5678")
  assert.equal(ledger.changes.PR2.length, 2)
  assert.equal(ledger.runs[0].env, "mac-e2e")
  assert.equal(ledger.runs[0].stories, 1)
  assert.equal(ledger.runs.length, 3)
})
