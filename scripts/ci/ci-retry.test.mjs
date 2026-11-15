// node --test scripts/ci/ 跑（公开 CI 的 Workflow lint 那一格）
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  activeFlaky,
  decide,
  failedSteps,
  failedTests,
  judgeJob,
} from "./ci-retry.mjs"

const ts = (s) => `2026-11-14T15:02:56.5459626Z ${s}`
const log = (...lines) => lines.map(ts).join("\n")
const flaky = {
  tests: [
    {
      test: "host_ssh::sshd::tests::the_service_starts",
      reason: "#231",
      expires: "2026-12-15",
    },
    { test: "old::flaky", reason: "x", expires: "2026-11-01" },
    { test: "no::reason", expires: "2026-12-31" },
  ],
}
const today = "2026-11-15"

const cargoFail = (name) =>
  log(
    "##[group]Run actions/checkout@v4",
    "ok",
    "##[group]Run cargo test --lib",
    `test ${name} ... FAILED`,
    "test other::thing ... ok",
    "failures:",
    "##[error]Process completed with exit code 101."
  )

test("名单：没过期、写了原因的才算", () => {
  const { active, expired } = activeFlaky(flaky, today)
  assert.deepEqual([...active], ["host_ssh::sshd::tests::the_service_starts"])
  assert.deepEqual(expired, ["old::flaky"])
  // 到期当天还算
  assert.ok(activeFlaky(flaky, "2026-12-15").active.size === 1)
  assert.ok(activeFlaky(flaky, "2026-12-16").active.size === 0)
})

test("没过的步骤：每个 exit code 往前到它的 ##[group]Run", () => {
  const { found, steps } = failedSteps(
    log(
      "##[group]Run a",
      "ECONNRESET in a step that passed",
      "##[group]Run cargo test",
      "boom",
      "##[error]Process completed with exit code 1.",
      "##[group]Run cargo clippy",
      "error: lint",
      "##[error]Process completed with exit code 101."
    )
  )
  assert.equal(found, true)
  assert.equal(steps.length, 2)
  assert.equal(steps[0][0], "##[group]Run cargo test")
  assert.equal(steps[1][0], "##[group]Run cargo clippy")
})

test("cargo 和 vitest 的测试名（去掉颜色）", () => {
  assert.deepEqual(
    failedTests([
      "test a::b::c ... FAILED",
      "test a::d ... ok",
      "\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m src/x/y.test.tsx\u001b[2m > \u001b[22mGroup — one\u001b[2m > \u001b[22mdoes it".replace(
        // eslint-disable-next-line no-control-regex
        /\u001b\[[0-9;]*m/g,
        ""
      ),
      "     × does it 5ms",
    ]),
    ["a::b::c", "src/x/y.test.tsx > Group — one > does it"]
  )
})

test("名单里的测试挂了 → 重跑；别的测试挂了 → 不重跑", () => {
  const { active } = activeFlaky(flaky, today)
  assert.equal(
    judgeJob(
      {
        name: "Rust server",
        log: cargoFail("host_ssh::sshd::tests::the_service_starts"),
      },
      active
    ).ok,
    true
  )
  const real = judgeJob(
    { name: "Rust server", log: cargoFail("acp::real_bug") },
    active
  )
  assert.equal(real.ok, false)
  assert.match(real.reason, /acp::real_bug/)
  // 过期的不算
  assert.equal(
    judgeJob({ name: "Rust server", log: cargoFail("old::flaky") }, active).ok,
    false
  )
})

test("没过的那一步里有网络错误 → 重跑；别的步骤里有不算", () => {
  const net = log(
    "##[group]Run pnpm install --frozen-lockfile",
    " ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/x: request to failed, reason: ECONNRESET",
    "##[error]Process completed with exit code 1."
  )
  assert.equal(
    judgeJob({ name: "Frontend build", log: net }, new Set()).ok,
    true
  )
  const elsewhere = log(
    "##[group]Run rust-cache",
    "failed to download cache: ETIMEDOUT",
    "##[group]Run cargo clippy",
    "error: this could be a `const fn`",
    "##[error]Process completed with exit code 101."
  )
  assert.equal(
    judgeJob({ name: "Rust cli", log: elsewhere }, new Set()).ok,
    false
  )
})

test("一个 job 里测试挂在名单上、clippy 又挂了 → 不重跑", () => {
  const { active } = activeFlaky(flaky, today)
  const both = log(
    "##[group]Run cargo test",
    "test host_ssh::sshd::tests::the_service_starts ... FAILED",
    "##[error]Process completed with exit code 101.",
    "##[group]Run cargo clippy",
    "error: lint",
    "##[error]Process completed with exit code 101."
  )
  assert.equal(judgeJob({ name: "Rust server", log: both }, active).ok, false)
})

test('rustfmt 的 diff 里有 "failed to fetch" 不算网络错误，fmt、lint 本来就不重跑', () => {
  const fmt = log(
    "##[group]Run cargo fmt --all --check",
    '-        .map_err(|e| AppCommandError::network(format!("failed to fetch models.dev catalog: {e}")))?;',
    "##[error]Process completed with exit code 1."
  )
  assert.equal(judgeJob({ name: "Rust fmt", log: fmt }, new Set()).ok, false)
  // 别的 job 里的 diff 行也不当输出
  assert.equal(judgeJob({ name: "Rust server", log: fmt }, new Set()).ok, false)
})

test("找不到没过的步骤时只认机器出问题", () => {
  const lost = log(
    "##[group]Run cargo test",
    "The runner has received a shutdown signal."
  )
  assert.equal(
    judgeJob({ name: "Rust desktop", log: lost }, new Set()).ok,
    true
  )
  const timeout = log(
    "##[group]Run cargo test",
    "test a::b has been running for over 60 seconds"
  )
  assert.equal(
    judgeJob({ name: "Rust desktop", log: timeout }, new Set()).ok,
    false
  )
})

test("整轮：所有没过的 job 都能重跑才重跑", () => {
  const ok = {
    name: "Rust server",
    log: cargoFail("host_ssh::sshd::tests::the_service_starts"),
  }
  const bad = { name: "Rust cli", log: cargoFail("cli::real") }
  assert.equal(decide([ok], flaky, today).retry, true)
  assert.equal(decide([ok, bad], flaky, today).retry, false)
  assert.equal(decide([], flaky, today).retry, false)
})
