import { beforeEach, describe, expect, it, vi } from "vitest"
import { downloadWorkspaceFile, uploadWorkspaceLocalPathsToRemote } from "./api"

// #366: 远程上传、下载里命令自己登录失败（不带标记的 `authentication_failed`）
// 不能把窗口当成连接过期登出；只有代理打了标记的 401 才登出。
const { call, notify, invoke, save } = vi.hoisted(() => ({
  call: vi.fn(),
  notify: vi.fn(),
  invoke: vi.fn(),
  save: vi.fn(),
}))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => 7,
  getShellTransport: () => ({ call }),
  getTransport: () => ({ call }),
  isDesktop: () => true,
  isRemoteDesktopMode: () => true,
  notifyRemoteDesktopUnauthorized: notify,
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }))

const commandFailure = {
  code: "authentication_failed",
  message: "upload: authentication failed",
}
const tokenRejected = {
  code: "authentication_failed",
  message: "Remote Workspace token is invalid",
  i18n_params: { reason: "remote_token_rejected" },
}

function upload() {
  return uploadWorkspaceLocalPathsToRemote({
    rootPath: "/repo",
    targetPath: "",
    entries: [{ localPath: "/tmp/a.txt" }],
  })
}

describe("remote upload and download auth failures", () => {
  beforeEach(() => {
    call.mockReset()
    notify.mockReset()
    invoke.mockReset()
    save.mockReset().mockResolvedValue("/tmp/saved.txt")
  })

  it("keeps the window when an upload fails its own login", async () => {
    call.mockRejectedValueOnce(commandFailure)
    await expect(upload()).rejects.toBe(commandFailure)
    expect(notify).not.toHaveBeenCalled()
  })

  it("logs the window out when the server refused its token on upload", async () => {
    call.mockRejectedValueOnce(tokenRejected)
    await expect(upload()).rejects.toBe(tokenRejected)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it("keeps the window when a download fails its own login", async () => {
    invoke.mockRejectedValueOnce(commandFailure)
    await expect(downloadWorkspaceFile("/repo", "a.txt", "a.txt")).rejects.toBe(
      commandFailure
    )
    expect(notify).not.toHaveBeenCalled()
  })

  it("logs the window out when the server refused its token on download", async () => {
    invoke.mockRejectedValueOnce(tokenRejected)
    await expect(downloadWorkspaceFile("/repo", "a.txt", "a.txt")).rejects.toBe(
      tokenRejected
    )
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
