#!/usr/bin/env node
// 公开仓库 dodoer-releases 的 cowork-test / cowork-bundle 用：拿 GitHub App（tinghecui-bot）的私钥现换一个安装令牌，打印到 stdout。
// 令牌只给列出的仓库、只带列出的权限，一小时过期。调用的那一步自己 ::add-mask::，再交给要用它的那一步。
// 用法：BOT_APP_ID=<id> BOT_APP_KEY=<私钥> node app-token.mjs <仓库,…（Tinghecui 下的名字）> <权限=read|write,…>
// 出错只往 stderr 写一句不带细节的话（这份日志是公开的），退出码 1。
import { createSign } from "node:crypto"

const OWNER = "Tinghecui"
const fail = (m) => {
  process.stderr.write(`app-token：${m}\n`)
  process.exit(1)
}
const [repoArg, permArg] = process.argv.slice(2)
const appId = process.env.BOT_APP_ID || ""
const key = (process.env.BOT_APP_KEY || "").trim()
if (!/^\d+$/.test(appId)) fail("没有 BOT_APP_ID")
if (!key.includes("PRIVATE KEY")) fail("没有 BOT_APP_KEY")
const repos = (repoArg || "").split(",").map((r) => r.trim()).filter(Boolean)
if (!repos.length || repos.some((r) => !/^[\w.-]+$/.test(r))) fail("仓库名不对")
const permissions = {}
for (const p of (permArg || "").split(",").filter(Boolean)) {
  const [k, v] = p.split("=")
  if (!/^[a-z_]+$/.test(k || "") || !["read", "write"].includes(v)) fail("权限要写成 名字=read|write")
  permissions[k] = v
}
if (!Object.keys(permissions).length) fail("至少要一个权限")

const b64 = (x) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url")
const now = Math.floor(Date.now() / 1000)
const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`
let jwt
try {
  jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url")}`
} catch {
  fail("私钥签不了名")
}

const api = async (method, path, body) => {
  let r
  for (let i = 0; i < 3; i++) {
    try {
      r = await fetch(`https://api.github.com${path}`, {
        method,
        headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "cowork-ci" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      })
      if (r.status < 500) break
    } catch {
      r = undefined
    }
    await new Promise((s) => setTimeout(s, 3000 * (i + 1)))
  }
  if (!r) fail(`${method} 连不上 GitHub`)
  if (!r.ok) fail(`${method} HTTP ${r.status}`)
  return r.json()
}

const inst = await api("GET", `/repos/${OWNER}/${repos[0]}/installation`)
const tok = await api("POST", `/app/installations/${inst.id}/access_tokens`, { repositories: repos, permissions })
if (!tok.token) fail("GitHub 没给令牌")
process.stdout.write(tok.token)
