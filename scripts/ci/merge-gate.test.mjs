// node --test scripts/ci/*.test.mjs 跑（公开 CI 的 Workflow lint 那一格）
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  gateStatus,
  parseJq,
  productState,
  sameStatus,
  sourceSha,
} from "./merge-gate.mjs"

const A = "a".repeat(40)
const B = "b".repeat(40)
const run = (conclusion, sha, status = "completed") => ({
  status,
  conclusion,
  head_sha: "f".repeat(40),
  html_url: `https://example.test/runs/${sha[0]}`,
  head_commit: {
    message: `subject\n\n- x（#1）\n\nsource: cowork-codeg@${sha}`,
  },
})

test("source sha 取最后一行那个", () => {
  assert.equal(sourceSha(`x\n\nsource: cowork-codeg@${A}`), A)
  assert.equal(
    sourceSha(`x\nsource: cowork-codeg@${A}\nsource: cowork-codeg@${B}`),
    B
  )
  assert.equal(sourceSha("no sha here"), null)
  assert.equal(sourceSha(`x source: cowork-codeg@${A} y`), null)
})

test("product 的状态看最近一次跑完的 success / failure", () => {
  assert.deepEqual(productState([run("failure", A), run("success", B)]), {
    green: false,
    sha: A,
    url: "https://example.test/runs/a",
  })
  // 被取消的、还在跑的（自动重跑那次）跳过，看它前面那次
  assert.equal(productState([run("cancelled", A), run("success", B)]).sha, B)
  assert.equal(
    productState([run(null, A, "in_progress"), run("success", B)]).green,
    true
  )
  assert.equal(productState([run("cancelled", A)]), null)
  assert.equal(productState([]), null)
})

test("status：红了关闸，描述不超过 140 字", () => {
  const red = gateStatus({ green: false, sha: A, url: "u" })
  assert.equal(red.state, "failure")
  assert.equal(red.context, "合并闸")
  assert.ok(red.description.length <= 140)
  assert.match(red.description, /aaaaaaa/)
  assert.equal(gateStatus({ green: true, sha: B, url: "u" }).state, "success")
})

test("一样就不重复打", () => {
  const want = gateStatus({ green: true, sha: B, url: "u" })
  assert.equal(sameStatus({ ...want, id: 1 }, want), true)
  assert.equal(sameStatus({ ...want, state: "failure" }, want), false)
  assert.equal(sameStatus(null, want), false)
})

test("gh --jq 出 null 时是空行", () => {
  assert.equal(parseJq("\n"), null)
  assert.equal(parseJq(""), null)
  assert.equal(parseJq(undefined), null)
  assert.deepEqual(parseJq('{"state":"success"}\n'), { state: "success" })
})
