// 更新流程测试的假更新源：在运行机的 127.0.0.1 上按 GitHub 的路径摆出一个发布仓库「e2e/fake」，
// e2e 测试版的 app 经 CODEG_E2E_UPDATER_ENDPOINTS 指过来（src-tauri/src/e2e.rs、update/rollback.rs 的 ReleaseSource）。
// 跟 run.mjs 在同一个进程里，测试步骤直接改它的状态（发一版、撤一版、换稳定版），不用另开控制接口。
//
//   GET /e2e/fake/releases/latest/download/<清单>          最新一版（抢先版）的清单（latest.json / latest-client.json / latest-x64.json 同一份）
//   GET /e2e/fake/releases/download/stable/<清单>          稳定版的清单；stable/history.json 是晋级过的版本（新的在前）
//   GET /e2e/fake/releases/download/v<版本>/<清单或包>      那一版自己的清单，或者它的更新包 dodoer-<版本>-macos-<架构>.app.tar.gz
//   GET /api/repos/e2e/fake/releases?per_page=100           发布列表（回退找上一版用）
//   GET /api/repos/e2e/fake/contents/<迁移列表>?ref=<tag>     那一版的数据库迁移列表（回退前读）：一律给这份 checkout 里的（各版一样）
//
// 只有清单、没有包的版本（package: null）用来测「查到了更新的一版」：app 只会读它的清单，不会去下它的包。
// 来历：源仓库 .cowork/journal/2026-11-22-e2e-update-feed.md
import { createReadStream, readFileSync, statSync } from "node:fs"
import http from "node:http"
import { join } from "node:path"

export const REPO = "e2e/fake"
const MANIFESTS = new Set([
  "latest.json",
  "latest-client.json",
  "latest-x64.json",
])
// src-tauri/src/update/rollback.rs 的 MIGRATION_LIST_PATH
const MIGRATION_LIST = "src-tauri/src/db/migration/mod.rs"

export function startFeed({ port, root, packagesDir, arch }) {
  // version → { version, packageFile|null, signature, publishedAt, notes }
  const releases = new Map()
  let latest = null
  let stable = null
  const history = []
  const requests = []
  const platform = arch === "x64" ? "darwin-x86_64" : "darwin-aarch64"
  const base = `http://127.0.0.1:${port}`

  const manifestOf = (version) => {
    const r = releases.get(version)
    if (!r) return null
    const tag = `v${version}`
    const file = r.packageFile || `dodoer-${version}-macos-${arch}.app.tar.gz`
    return {
      version,
      notes: r.notes,
      pub_date: r.publishedAt,
      platforms: {
        [platform]: {
          signature: r.signature,
          url: `${base}/${REPO}/releases/download/${tag}/${file}`,
        },
      },
    }
  }

  const send = (res, status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type })
    res.end(typeof body === "string" ? body : JSON.stringify(body))
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, base)
    const path = decodeURIComponent(url.pathname)
    requests.push({ at: Date.now(), path, query: url.search })
    let m
    if (
      (m = path.match(/^\/e2e\/fake\/releases\/latest\/download\/([^/]+)$/))
    ) {
      if (!MANIFESTS.has(m[1]) || !latest)
        return send(res, 404, "Not Found", "text/plain")
      return send(res, 200, manifestOf(latest))
    }
    if (
      (m = path.match(/^\/e2e\/fake\/releases\/download\/stable\/([^/]+)$/))
    ) {
      if (m[1] === "history.json") {
        return send(res, 200, {
          versions: history.map((v) => ({
            version: v,
            tag: `v${v}`,
            promoted_at: releases.get(v)?.publishedAt ?? null,
          })),
        })
      }
      if (!MANIFESTS.has(m[1]) || !stable)
        return send(res, 404, "Not Found", "text/plain")
      return send(res, 200, manifestOf(stable))
    }
    if (
      (m = path.match(/^\/e2e\/fake\/releases\/download\/v([^/]+)\/([^/]+)$/))
    ) {
      const r = releases.get(m[1])
      if (!r) return send(res, 404, "Not Found", "text/plain")
      if (MANIFESTS.has(m[2])) return send(res, 200, manifestOf(m[1]))
      if (r.packageFile && m[2] === r.packageFile) {
        const file = join(packagesDir, r.packageFile)
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": statSync(file).size,
        })
        return createReadStream(file).pipe(res)
      }
      return send(res, 404, "Not Found", "text/plain")
    }
    if (path === "/api/repos/e2e/fake/releases") {
      // GitHub 的顺序：新发的在前
      const list = [...releases.values()]
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .map((r) => ({
          tag_name: `v${r.version}`,
          draft: false,
          prerelease: false,
          published_at: r.publishedAt,
          assets: [
            ...MANIFESTS,
            ...(r.packageFile ? [r.packageFile, `${r.packageFile}.sig`] : []),
          ].map((name) => ({ name })),
        }))
      return send(res, 200, list)
    }
    if ((m = path.match(/^\/api\/repos\/e2e\/fake\/contents\/(.+)$/))) {
      // 只给回退要读的那一个文件
      if (m[1] !== MIGRATION_LIST)
        return send(res, 404, "Not Found", "text/plain")
      try {
        return send(
          res,
          200,
          readFileSync(join(root, m[1]), "utf8"),
          "text/plain"
        )
      } catch {
        return send(res, 404, "Not Found", "text/plain")
      }
    }
    return send(res, 404, "Not Found", "text/plain")
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () =>
      resolve({
        base,
        // app 配置里的更新地址（e2e 测试版经 CODEG_E2E_UPDATER_ENDPOINTS 换成它）
        endpoint: (manifest = "latest.json") =>
          `${base}/${REPO}/releases/latest/download/${manifest}`,
        // 发一版：有包的（package = 包的文件名，旁边有 .sig）或者只有清单的（package = null）
        publish(version, { package: packageFile = null, notes } = {}) {
          const signature = packageFile
            ? readFileSync(
                join(packagesDir, `${packageFile}.sig`),
                "utf8"
              ).trim()
            : "dW50cnVzdGVkIGNvbW1lbnQ6IG5vdCBhIHJlYWwgc2lnbmF0dXJlCg=="
          releases.set(version, {
            version,
            packageFile,
            signature,
            notes: notes ?? `e2e release ${version}`,
            // 每次发版的时间都往后，列表按它排
            publishedAt: new Date(
              Date.now() + releases.size * 1000
            ).toISOString(),
          })
          latest = version
        },
        // 撤掉一版（Release 删了），最新的回到剩下里最后发的那一版
        unpublish(version) {
          releases.delete(version)
          const left = [...releases.values()].sort((a, b) =>
            a.publishedAt.localeCompare(b.publishedAt)
          )
          latest = left.length ? left[left.length - 1].version : null
        },
        // 稳定版指到 version，并记进 history.json（新的在前）
        promote(version) {
          stable = version
          if (!history.includes(version)) history.unshift(version)
        },
        // 回到空的：没有发布、没有稳定版（每段开头）
        reset() {
          releases.clear()
          history.length = 0
          latest = null
          stable = null
        },
        get latest() {
          return latest
        },
        requests,
        // 从 since（毫秒时间戳）以后，路径里带 needle 的请求
        requested: (needle, since = 0) =>
          requests.filter((r) => r.at >= since && r.path.includes(needle)),
        close: () => new Promise((r) => server.close(r)),
      })
    )
  })
}
