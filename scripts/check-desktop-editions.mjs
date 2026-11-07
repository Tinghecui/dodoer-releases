#!/usr/bin/env node
// 两种桌面包（完整版、纯客户端版，见 COWORK.md「桌面端：完整版和纯客户端版」）在 PR 上能查的部分：不编译，一秒跑完。
// 公开镜像 test.yml 的「Desktop editions」job 跑它；编出来的包要到 desktop-macos.yml（tag、每晚、PR 打 macos-build 标签）才核对。
//
// 1. Tauri 配置按 macOS 上的叠法合出来（tauri.conf.json → tauri.macos.conf.json → scripts/cowork-desktop-build.sh 的 --config，
//    JSON Merge Patch，数组整个替换），核对两种包各自的 externalBin 和 updater：完整版带 codeg-server、从 latest.json 更新；
//    纯客户端版不带 codeg-server、从 latest-client.json 更新；公钥同一个。
// 2. Cargo feature `client-only` 只是 local_daemon.rs 里的一个 cfg! 常量（两种包是同一份代码，所以 Rust desktop 那一格已经编过
//    纯客户端版的全部代码）。谁要是加了 #[cfg(feature = "client-only")] 或者让这个 feature 带上依赖，就有了只在纯客户端版里编的代码，
//    PR 上没人编过它：这里报错，要么改回 cfg! 常量，要么给 test.yml 加一格 `--features client-only`，再改这个检查。
//
//   用法：node scripts/check-desktop-editions.mjs
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(fileURLToPath(import.meta.url), "../..")
const tauriDir = join(root, "src-tauri")
const releases =
  "https://github.com/Tinghecui/dodoer-releases/releases/latest/download"
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

// 构建脚本里每种包叠哪些配置：configs=(…) 是两种都有的，client) 分支里 configs+=(…) 是纯客户端版多叠的
const buildScript = readFileSync(
  join(root, "scripts/cowork-desktop-build.sh"),
  "utf8"
)
const configFiles = (text) =>
  [...text.matchAll(/--config (src-tauri\/tauri\.[\w.-]+\.conf\.json)/g)].map(
    (m) => m[1]
  )
const common = configFiles(buildScript.match(/^configs=\(.*\)$/m)?.[0] ?? "")
const clientExtra = configFiles(
  buildScript.match(/^\s*client\)\n[\s\S]*?;;/m)?.[0] ?? ""
)
if (common.length === 0)
  fail("cowork-desktop-build.sh 里找不到 configs=(--config …)，检查脚本跟着改")
if (clientExtra.length === 0)
  fail("cowork-desktop-build.sh 的 client) 分支里找不到 configs+=(--config …)")

const merged = (files) =>
  ["src-tauri/tauri.conf.json", "src-tauri/tauri.macos.conf.json", ...files]
    .map(readJson)
    .reduce(mergePatch, {})

const editions = {
  full: {
    config: merged(common),
    endpoint: `${releases}/latest.json`,
    server: true,
  },
  client: {
    config: merged([...common, ...clientExtra]),
    endpoint: `${releases}/latest-client.json`,
    server: false,
  },
}

for (const [name, { config, endpoint, server }] of Object.entries(editions)) {
  const bins = config.bundle?.externalBin ?? []
  const has = (bin) => bins.includes(`binaries/${bin}`)
  if (has("codeg-server") !== server)
    fail(
      `${name}：externalBin ${server ? "要" : "不能"}带 codeg-server，现在是 ${JSON.stringify(bins)}`
    )
  for (const bin of ["codeg-mcp", "codeg-cli"])
    if (!has(bin))
      fail(`${name}：externalBin 少了 ${bin}，现在是 ${JSON.stringify(bins)}`)
  const updater = config.plugins?.updater ?? {}
  const endpoints = updater.endpoints ?? []
  if (endpoints.length !== 1 || endpoints[0] !== endpoint)
    fail(
      `${name}：updater endpoints 要是 ["${endpoint}"]，现在是 ${JSON.stringify(endpoints)}`
    )
  if (!config.bundle?.createUpdaterArtifacts)
    fail(`${name}：bundle.createUpdaterArtifacts 没开，发版时出不了自动更新包`)
  if (!updater.pubkey) fail(`${name}：updater 没有 pubkey`)
}
if (
  editions.full.config.plugins?.updater?.pubkey !==
  editions.client.config.plugins?.updater?.pubkey
)
  fail("两种包的 updater 公钥不一样：desktop-macos.yml 用同一把私钥签两种包")
if (
  editions.full.config.identifier !== editions.client.config.identifier ||
  editions.full.config.productName !== editions.client.config.productName
)
  fail(
    "两种包的 identifier / productName 不一样：换装要保住已保存的连接和钥匙串，见 COWORK.md"
  )

// --- 2. client-only feature 只是一个 cfg! 常量 ----------------------------

const cargo = readFileSync(join(tauriDir, "Cargo.toml"), "utf8")
const featureLine = cargo.match(/^client-only\s*=.*$/m)?.[0]
if (!featureLine) fail("Cargo.toml 的 [features] 里没有 client-only")
else if (!/^client-only\s*=\s*\[\s*\]\s*$/.test(featureLine))
  fail(
    `Cargo.toml：client-only 要是空 feature（不带依赖、不开别的 feature），现在是 ${featureLine}`
  )

const allowed =
  'pub const CLIENT_ONLY_BUILD: bool = cfg!(feature = "client-only");'
const rustFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? rustFiles(join(dir, e.name))
      : e.name.endsWith(".rs")
        ? [join(dir, e.name)]
        : []
  )
let constFound = false
for (const file of [
  join(tauriDir, "build.rs"),
  ...rustFiles(join(tauriDir, "src")),
]) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!/feature\s*=\s*"client-only"/.test(line)) return
      const rel = relative(root, file)
      if (rel === "src-tauri/src/local_daemon.rs" && line.trim() === allowed)
        constFound = true
      else
        fail(
          `${rel}:${i + 1}：client-only 只能经 local_daemon::CLIENT_ONLY_BUILD 用（cfg! 常量），不能 cfg 掉代码：${line.trim()}`
        )
    })
}
if (!constFound) fail(`src-tauri/src/local_daemon.rs 里找不到 \`${allowed}\``)

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`)
  process.exit(1)
}
for (const [name, { config }] of Object.entries(editions))
  console.log(
    `${name}: externalBin ${JSON.stringify(config.bundle.externalBin)}, updater ${config.plugins.updater.endpoints[0]}`
  )
console.log(
  `client-only：只有 local_daemon::CLIENT_ONLY_BUILD 一处；配置叠法 ${[...common, ...clientExtra].join(" → ")}`
)
