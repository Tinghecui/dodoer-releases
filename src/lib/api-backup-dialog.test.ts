import { beforeEach, describe, expect, it, vi } from "vitest"
import { exportBackupDesktop } from "./api"

const { call, save } = vi.hoisted(() => ({ call: vi.fn(), save: vi.fn() }))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
  isDesktop: () => true,
}))
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }))

// 系统保存对话框里的文件类型名是用户看得见的产品名，和界面一样写 CoTeam；
// 文件名和扩展名（codeg-backup-*、.codegbak）是标识符，不改。
describe("desktop backup export dialog", () => {
  beforeEach(() => {
    call.mockReset()
    save.mockReset().mockResolvedValue(null)
  })

  it("names the file type CoTeam for a plain and an encrypted backup", async () => {
    await exportBackupDesktop({ includeExternalTranscripts: false })
    await exportBackupDesktop({
      includeExternalTranscripts: false,
      passphrase: "pw",
    })
    expect(save).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^codeg-backup-.*\.codeg\.zip$/),
        filters: [{ name: "CoTeam backup", extensions: ["codeg.zip"] }],
      })
    )
    expect(save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filters: [{ name: "CoTeam backup", extensions: ["codegbak"] }],
      })
    )
    // 对话框取消了就不调后端
    expect(call).not.toHaveBeenCalled()
  })
})
