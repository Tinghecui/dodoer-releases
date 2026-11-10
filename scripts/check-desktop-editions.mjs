#!/usr/bin/env node
// 桌面包（只有一种：完整版，见 COWORK.md「桌面端：一种包、开始页」）在 PR 上能查的部分：不编译，一秒跑完。
// 公开镜像 test.yml 的「Desktop editions」job 跑它；编出来的包要到 desktop-macos.yml（tag、每晚、PR 打 macos-build 标签）才核对。
//
// 1. Tauri 配置按 macOS 上的叠法合出来（tauri.conf.json → tauri.macos.conf.json → scripts/cowork-desktop-build.sh 的 --config，
//    JSON Merge Patch，数组整个替换），核对 externalBin（codeg-server、codeg-mcp、codeg-cli 都在）、updater（公钥、从 latest.json
//    更新、出自动更新包）和 identifier（app.codeg：以前装的纯客户端版就地更新成这个包，数据目录、钥匙串、codeg:// 注册都跟着它）。
// 2. 纯客户端版（2026-11-09 去掉）没有留下东西：Cargo feature `client-only`、src-tauri/tauri.cowork-client.conf.json、
//    构建脚本里的 client 分支、Rust 里的 `CLIENT_ONLY_BUILD` / `feature = "client-only"`。
//
//   用法：node scripts/check-desktop-editions.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(fileURLToPath(import.meta.url), "../..")
const tauriDir = join(root, "src-tauri")
const releases =
  "https://github.com/Tinghecui/dodoer-releases/releases/latest/download"
const identifier = "app.codeg"
const errors = []
const fail = (msg) => errors.push(msg)

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"))
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
// RFC 7396，和 Tauri CLI 合 --config / 平台配置的规则一样
const mergePatch = (target, patch) => {
  if (!isObject(patch)) return patch
  const out = isObject(target) ? { ...target } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else out[k] = mergePatch(out[k], v)
  }
  return out
}

// --- 1. Tauri 配置 ---------------------------------------------------------

// 构建脚本叠哪些配置：configs=(…) 那一行
const buildScript = readFileSync(
  join(root, "scripts/cowork-desktop-build.sh"),
  "utf8"
)
const configFiles = (text) =>
  [...text.matchAll(/--config (src-tauri\/tauri\.[\w.-]+\.conf\.json)/g)].map(
    (m) => m[1]
  )
const layers = configFiles(buildScript.match(/^configs=\(.*\)$/m)?.[0] ?? "")
if (layers.length === 0)
  fail("cowork-desktop-build.sh 里找不到 configs=(--config …)，检查脚本跟着改")
const extraLayers = configFiles(buildScript).filter((f) => !layers.includes(f))
if (extraLayers.length)
  fail(
    `cowork-desktop-build.sh 在 configs=(…) 之外还叠了 ${extraLayers.join("、")}：只有一种包，配置都写在那一行`
  )

const config = [
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.macos.conf.json",
  ...layers,
]
  .map(readJson)
  .reduce(mergePatch, {})

const bins = config.bundle?.externalBin ?? []
for (const bin of ["codeg-server", "codeg-mcp", "codeg-cli"])
  if (!bins.includes(`binaries/${bin}`))
    fail(`externalBin 少了 ${bin}，现在是 ${JSON.stringify(bins)}`)
const updater = config.plugins?.updater ?? {}
const endpoint = `${releases}/latest.json`
const endpoints = updater.endpoints ?? []
if (endpoints.length !== 1 || endpoints[0] !== endpoint)
  fail(
    `updater endpoints 要是 ["${endpoint}"]，现在是 ${JSON.stringify(endpoints)}`
  )
if (!updater.pubkey) fail("updater 没有 pubkey")
if (!config.bundle?.createUpdaterArtifacts)
  fail("bundle.createUpdaterArtifacts 没开，发版时出不了自动更新包")
if (config.identifier !== identifier)
  fail(
    `identifier 要是 ${identifier}，现在是 ${config.identifier}：已经装好的 app（包括纯客户端版）按它就地更新、找数据目录，见 COWORK.md`
  )

// --- 2. 纯客户端版没有留下东西 -----------------------------------------------

const cargo = readFileSync(join(tauriDir, "Cargo.toml"), "utf8")
const featureLine = cargo.match(/^client-only\s*=.*$/m)?.[0]
if (featureLine)
  fail(`Cargo.toml 的 [features] 里还有 client-only：${featureLine}`)
if (existsSync(join(tauriDir, "tauri.cowork-client.conf.json")))
  fail("src-tauri/tauri.cowork-client.conf.json 还在：只有一种包")
if (/^\s*client\)/m.test(buildScript) || /client-only/.test(buildScript))
  fail("cowork-desktop-build.sh 里还有 client 分支 / client-only")

const rustFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? rustFiles(join(dir, e.name))
      : e.name.endsWith(".rs")
        ? [join(dir, e.name)]
        : []
  )
for (const file of [
  join(tauriDir, "build.rs"),
  ...rustFiles(join(tauriDir, "src")),
]) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (
        /feature\s*=\s*"client-only"/.test(line) ||
        /\bCLIENT_ONLY_BUILD\b/.test(line)
      )
        fail(
          `${relative(root, file)}:${i + 1}：纯客户端版已经去掉，这里还在用它：${line.trim()}`
        )
    })
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`)
  process.exit(1)
}
console.log(
  `full: externalBin ${JSON.stringify(config.bundle.externalBin)}, updater ${endpoints[0]}, identifier ${config.identifier}`
)
console.log(
  `配置叠法 ${layers.join(" → ")}；没有 client-only feature、tauri.cowork-client.conf.json`
)
