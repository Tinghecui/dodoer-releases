// 桌面 e2e（公开镜像 desktop-e2e.yml）：同一套 WebdriverIO spec 在 macOS 和 Linux 上驱动桌面 app 的 e2e 测试版。
// - macOS：app 是带 `e2e` feature 编的 debug 版，进程里内嵌 WebDriver 服务器（tauri-plugin-wdio-webdriver），
//   @wdio/tauri-service 的 embedded 方式直接把 app 带起来、连上去
// - Linux：官方 tauri-driver + WebKitWebDriver（external 方式）
// 一次 `wdio run` 只开一次 app（app 在 onPrepare 起、onComplete 杀），所以「退出重开」是 run.sh 按段跑几次：
// E2E_PHASE=<N> 跑 specs/0<N>-*.mjs，中间 app 退出、数据目录不变。
//
//   环境：E2E_APP（app 程序，默认 src-tauri/target/debug/codeg）、E2E_DATA_DIR（CODEG_DATA_DIR / CODEG_HOME，几段共用，必填）、
//        E2E_OUT（截图、结果放哪，默认 e2e-out）、E2E_PHASE（1、2、3……）、TAURI_DRIVER（Linux，默认 ~/.cargo/bin/tauri-driver）
// 来历：源仓库 .cowork/journal/2026-11-21-spike-macos-webdriver.md、2026-11-21-desktop-e2e-skeleton.md
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))
const root = resolve(here, "..", "..")
const app = resolve(root, process.env.E2E_APP || "src-tauri/target/debug/codeg")
const dataDir = process.env.E2E_DATA_DIR
if (!dataDir) throw new Error("E2E_DATA_DIR 没设：两次启动要共用一个数据目录")
const out = resolve(root, process.env.E2E_OUT || "e2e-out")
mkdirSync(out, { recursive: true })
const phase = process.env.E2E_PHASE || "1"
if (!/^[1-9]$/.test(phase)) throw new Error(`E2E_PHASE=${phase}`)
const mac = process.platform === "darwin"

const env = {
  CODEG_DATA_DIR: dataDir,
  CODEG_HOME: dataDir,
  CODEG_UPDATE_DISABLED: "1",
  CODEG_TELEMETRY_ENV: "ci",
}

export const config = {
  runner: "local",
  specs: [join(here, "specs", `0${phase}-*.mjs`)],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: app },
      "wdio:tauriServiceOptions": { appBinaryPath: app, env },
    },
  ],
  services: [
    [
      "@wdio/tauri-service",
      mac
        ? { driverProvider: "embedded", startTimeout: 120000, env }
        : {
            driverProvider: "external",
            tauriDriverPath:
              process.env.TAURI_DRIVER ||
              join(homedir(), ".cargo", "bin", "tauri-driver"),
            env,
          },
    ],
  ],
  logLevel: "info",
  outputDir: join(out, "wdio-logs"),
  waitforTimeout: 20000,
  connectionRetryTimeout: 180000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 180000 },
}
