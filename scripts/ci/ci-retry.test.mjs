// node --test scripts/ci/ 跑（公开 CI 的 Workflow lint 那一格）
import assert from "node:assert/strict"
import { test } from "node:test"
import { decide, failedSteps, failedTests, judgeJob } from "./ci-retry.mjs"

const ts = (s) => `2026-11-14T15:02:56.5459626Z ${s}`
const log = (...lines) => lines.map(ts).join("\n")
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

test("测试挂了 → 不重跑（步骤里已经单独重跑过一次了），原因里写是哪条", () => {
  const real = judgeJob({
    name: "Rust server",
    log: cargoFail("host_ssh::sshd::tests::the_service_starts"),
  })
  assert.equal(real.ok, false)
  assert.match(real.reason, /host_ssh::sshd::tests::the_service_starts 没过/)
  const build = judgeJob({
    name: "Rust cli",
    log: log(
      "##[group]Run cargo test",
      "error[E0425]: cannot find value `x` in this scope",
      "##[error]Process completed with exit code 101."
    ),
  })
  assert.equal(build.ok, false)
  assert.match(build.reason, /不是测试没过/)
})

test("没过的那一步里有网络错误 → 重跑；别的步骤里有不算", () => {
  const net = log(
    "##[group]Run pnpm install --frozen-lockfile",
    " ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/x: request to failed, reason: ECONNRESET",
    "##[error]Process completed with exit code 1."
  )
  assert.equal(judgeJob({ name: "Frontend build", log: net }).ok, true)
  const elsewhere = log(
    "##[group]Run rust-cache",
    "failed to download cache: ETIMEDOUT",
    "##[group]Run cargo clippy",
    "error: this could be a `const fn`",
    "##[error]Process completed with exit code 101."
  )
  assert.equal(judgeJob({ name: "Rust cli", log: elsewhere }).ok, false)
})

test("一个 job 里一步是网络错误、另一步是真失败 → 不重跑", () => {
  const both = log(
    "##[group]Run pnpm install --frozen-lockfile",
    "ERR_PNPM_FETCH_FAILED",
    "##[error]Process completed with exit code 1.",
    "##[group]Run cargo clippy",
    "error: lint",
    "##[error]Process completed with exit code 101."
  )
  assert.equal(judgeJob({ name: "Rust server", log: both }).ok, false)
})

test('rustfmt 的 diff 里有 "failed to fetch" 不算网络错误，fmt、lint 本来就不重跑', () => {
  const fmt = log(
    "##[group]Run cargo fmt --all --check",
    '-        .map_err(|e| AppCommandError::network(format!("failed to fetch models.dev catalog: {e}")))?;',
    "##[error]Process completed with exit code 1."
  )
  assert.equal(judgeJob({ name: "Rust fmt", log: fmt }).ok, false)
  // 别的 job 里的 diff 行也不当输出
  assert.equal(judgeJob({ name: "Rust server", log: fmt }).ok, false)
})

test("找不到没过的步骤时只认机器出问题", () => {
  const lost = log(
    "##[group]Run cargo test",
    "The runner has received a shutdown signal."
  )
  assert.equal(judgeJob({ name: "Rust desktop", log: lost }).ok, true)
  const timeout = log(
    "##[group]Run cargo test",
    "test a::b has been running for over 60 seconds"
  )
  assert.equal(judgeJob({ name: "Rust desktop", log: timeout }).ok, false)
})

test("整轮：所有没过的 job 都能重跑才重跑", () => {
  const ok = {
    name: "Frontend vitest (2/6)",
    log: log(
      "##[group]Run pnpm install --frozen-lockfile",
      "request to https://registry.npmjs.org/x failed, reason: ECONNRESET",
      "##[error]Process completed with exit code 1."
    ),
  }
  const bad = { name: "Rust cli", log: cargoFail("cli::real") }
  assert.equal(decide([ok]).retry, true)
  assert.equal(decide([ok, bad]).retry, false)
  assert.equal(decide([]).retry, false)
})
