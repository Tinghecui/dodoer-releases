#!/usr/bin/env node
// 合并闸：product 上的 Test 红了，就不让 PR 自动合进来，修好（变绿）再放开。
// 公开仓库的 report-status.yml 每次 Test 开始、结束都调它一次：看公开 main（= 私有 product）上最近一次跑完的 Test，
// 给每个公开 pr/<n> 分支对应的私有 PR 头提交打 commit status「合并闸」（success = 放行，failure = 关着）。
// product 的 ruleset 把「合并闸」设成必需检查以后，auto-merge 在闸关着时就停着，变绿后自己接着合。
// 思路照 jenny 的 dev-flow（ACanvasHERE/dodoer 的 scripts/dev-flow/checks.md「主分支本身检查不过」），
// 规则见 COWORK.md「合并：auto-merge 和 product 的 ruleset」。修红的那个 PR 自己也过不了闸：`gh pr merge <编号> --merge --admin`。
//
//   用法：node scripts/ci/merge-gate.mjs
//   环境：PUBLIC_REPO（公开仓库，默认 Tinghecui/dodoer-releases）、GH_TOKEN（能读公开仓库的 Actions 和分支），
//        SOURCE_REPO（默认 Tinghecui/cowork-codeg）、SOURCE_TOKEN（对私有仓库有 Commit statuses 读写）
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const CONTEXT = "合并闸"

/** 提交说明里的 `source: cowork-codeg@<40 位 sha>`（最后一个） */
export function sourceSha(message) {
  const all = [
    ...(message ?? "").matchAll(/^source: cowork-codeg@([0-9a-f]{40})$/gm),
  ]
  return all.length > 0 ? all[all.length - 1][1] : null
}

/**
 * product 现在是红是绿：公开 main 上最近一次跑完、结论是 success 或 failure 的 Test（API 按新到旧排）。
 * 还在跑的、被取消的不算（自动重跑那次在跑时，看的是它前面那次）。都没有就是 null，不动闸。
 */
export function productState(runs) {
  const run = (runs ?? []).find(
    (r) =>
      r.status === "completed" &&
      (r.conclusion === "success" || r.conclusion === "failure")
  )
  if (!run) return null
  const sha = sourceSha(run.head_commit?.message) ?? run.head_sha
  return { green: run.conclusion === "success", sha, url: run.html_url }
}

/** gh --jq 的输出转回 JSON：jq 出 null 时 gh 打的是空行，不是 `null` */
export function parseJq(text) {
  const t = (text ?? "").trim()
  return t === "" ? null : JSON.parse(t)
}

/** 要打的 status（描述最多 140 个字符） */
export function gateStatus(state) {
  const short = state.sha.slice(0, 7)
  return {
    state: state.green ? "success" : "failure",
    target_url: state.url,
    context: CONTEXT,
    description: state.green
      ? `product 是绿的（${short}）`
      : `product 上 Test 红了（${short}），修好前不自动合；修红的 PR 用 --admin 合`,
  }
}

/** 已经是这个状态就不再打（同一个提交同一个 context 最多 1000 条 status） */
export function sameStatus(current, want) {
  return (
    current?.state === want.state &&
    current?.description === want.description &&
    current?.target_url === want.target_url
  )
}

function gh(token, args, input) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 64 * 1024 * 1024,
  })
}

function main() {
  const pub = process.env.PUBLIC_REPO || "Tinghecui/dodoer-releases"
  const src = process.env.SOURCE_REPO || "Tinghecui/cowork-codeg"
  const pubToken = process.env.GH_TOKEN
  const srcToken = process.env.SOURCE_TOKEN
  if (!srcToken) {
    console.log("::warning::没有 SOURCE_TOKEN，合并闸不打")
    return
  }
  const runs = JSON.parse(
    gh(pubToken, [
      "api",
      `repos/${pub}/actions/workflows/test.yml/runs?branch=main&event=push&status=completed&per_page=20`,
      "--jq",
      ".workflow_runs",
    ])
  )
  const state = productState(runs)
  if (!state) {
    console.log("公开 main 上没有跑完的 Test，不动合并闸")
    return
  }
  const want = gateStatus(state)
  console.log(
    `product ${state.green ? "绿" : "红"}（${state.sha.slice(0, 12)}，${state.url}）`
  )
  const refs = JSON.parse(
    gh(pubToken, [
      "api",
      `repos/${pub}/git/matching-refs/heads/pr/`,
      "--jq",
      "[.[] | {ref, sha: .object.sha}]",
    ])
  )
  for (const { ref, sha } of refs) {
    const message = gh(pubToken, [
      "api",
      `repos/${pub}/git/commits/${sha}`,
      "--jq",
      ".message",
    ])
    const head = sourceSha(message)
    if (!head) {
      console.log(`${ref}：提交说明里没有 source sha，跳过`)
      continue
    }
    const current = parseJq(
      gh(srcToken, [
        "api",
        `repos/${src}/commits/${head}/statuses?per_page=100`,
        "--jq",
        `[.[] | select(.context == "${CONTEXT}")][0]`,
      ])
    )
    if (sameStatus(current, want)) {
      console.log(`${ref} → ${head.slice(0, 12)}：已经是 ${want.state}`)
      continue
    }
    gh(
      srcToken,
      ["api", "-X", "POST", `repos/${src}/statuses/${head}`, "--input", "-"],
      JSON.stringify(want)
    )
    console.log(`${ref} → ${head.slice(0, 12)}：合并闸 ${want.state}`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
