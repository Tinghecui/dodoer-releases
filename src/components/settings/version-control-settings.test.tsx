import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  detectGit: vi.fn(),
  getGitSettings: vi.fn(),
  updateGitSettings: vi.fn(),
  testGitPath: vi.fn(),
  getGitHubAccounts: vi.fn(),
  updateGitHubAccounts: vi.fn(),
  validateGitHubToken: vi.fn(),
  validateGitLabToken: vi.fn(),
  validateGiteaToken: vi.fn(),
  validateCnbToken: vi.fn(),
  probeGitServer: vi.fn(),
  getAccountToken: vi.fn(),
  deleteAccountToken: vi.fn(),
  saveAccountToken: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

// 提交身份那张卡片有自己的测试（git-identity-settings.test）。
vi.mock("./git-identity-settings", () => ({
  GitIdentitySettings: () => <div data-testid="git-identity" />,
}))

// The worktree section has its own tests (worktree-location-settings.test).
vi.mock("./worktree-location-settings", () => ({
  WorktreeLocationSettings: () => <div data-testid="worktree-location" />,
}))

import { VersionControlSettings } from "./version-control-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  detectGit,
  getGitSettings,
  getGitHubAccounts,
  testGitPath,
  updateGitHubAccounts,
  updateGitSettings,
  getAccountToken,
  probeGitServer,
} from "@/lib/api"
import { toast } from "sonner"
import type { GitHubAccount } from "@/lib/types"

const mockDetectGit = vi.mocked(detectGit)
const mockGetGitSettings = vi.mocked(getGitSettings)
const mockGetGitHubAccounts = vi.mocked(getGitHubAccounts)
const mockUpdateGitHubAccounts = vi.mocked(updateGitHubAccounts)
const mockUpdateGitSettings = vi.mocked(updateGitSettings)
const mockTestGitPath = vi.mocked(testGitPath)

function account(overrides: Partial<GitHubAccount> = {}): GitHubAccount {
  return {
    id: "acc-1",
    server_url: "https://gitlab.example.com",
    username: "feitao",
    scopes: ["api"],
    avatar_url: null,
    is_default: false,
    created_at: "2026-08-22T01:28:18.613Z",
    provider: "gitlab",
    ...overrides,
  }
}

function renderWithIntl() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <VersionControlSettings />
    </NextIntlClientProvider>
  )
}

describe("VersionControlSettings account avatars", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDetectGit.mockResolvedValue({
      installed: true,
      version: "git version 2.39.0",
      path: "/usr/bin/git",
    })
    mockGetGitSettings.mockResolvedValue({ custom_path: null })
  })

  /**
   * The bug this pins: GitLab reports an avatar for every user whether or not
   * one was ever uploaded — for the rest it hands out a third-party
   * gravatar.com URL, which plenty of networks cannot reach. The row used to
   * treat "has a URL" as "will render a picture" and drew the initial only
   * when the URL was absent, so an unreachable avatar left an empty circle
   * with nothing in it at all.
   */
  it("falls back to the username initial when the avatar image does not load", async () => {
    mockGetGitHubAccounts.mockResolvedValue({
      accounts: [
        account({
          avatar_url:
            "https://www.gravatar.com/avatar/d02859952a42d0ece18c424a5b1e5cac?s=80&d=identicon",
        }),
      ],
    })

    renderWithIntl()

    // jsdom never loads images, which is exactly the state a blocked or
    // login-walled avatar host leaves the real webview in.
    await waitFor(() => expect(screen.getByText("F")).toBeInTheDocument())
  })

  it("shows the username initial for an account with no avatar at all", async () => {
    mockGetGitHubAccounts.mockResolvedValue({
      accounts: [
        account({
          id: "acc-2",
          server_url: "https://github.com",
          username: "octocat",
          provider: "github",
          avatar_url: null,
        }),
      ],
    })

    renderWithIntl()

    await waitFor(() => expect(screen.getByText("O")).toBeInTheDocument())
  })

  it("keeps a placeholder for a username whose first character is astral", async () => {
    mockGetGitHubAccounts.mockResolvedValue({
      accounts: [account({ username: "𝒥ane", avatar_url: null })],
    })

    renderWithIntl()

    // Indexing with [0] would have split the surrogate pair and rendered a
    // replacement glyph instead of a letter.
    await waitFor(() => expect(screen.getByText("𝒥")).toBeInTheDocument())
  })
})

describe("VersionControlSettings forge sections", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDetectGit.mockResolvedValue({
      installed: true,
      version: "git version 2.39.0",
      path: "/usr/bin/git",
    })
    mockGetGitSettings.mockResolvedValue({ custom_path: null })
  })

  /**
   * A declared Gitea account has to land in the Gitea section and NOWHERE else.
   * The section that would otherwise swallow it is the plain-git one at the
   * bottom — a catch-all defined by what the forge sections leave behind — and
   * an account filed there loses the two actions only a forge account gets
   * (test the token against the API, rotate it in place).
   */
  it("files a declared Gitea account under Gitea, not among the plain git credentials", async () => {
    mockGetGitHubAccounts.mockResolvedValue({
      accounts: [
        account({
          id: "acc-gitea",
          server_url: "https://git.corp.example",
          username: "tea",
          provider: "gitea",
          avatar_url: null,
        }),
      ],
    })

    renderWithIntl()

    await waitFor(() =>
      expect(screen.getByText("Gitea accounts")).toBeInTheDocument()
    )
    // The empty-state of the section it must NOT be in, which is only rendered
    // when that section really has nothing.
    expect(
      screen.getByText("No Git server accounts configured.")
    ).toBeInTheDocument()
    // …and the Gitea section's own empty-state is gone, because the account
    // is in it.
    expect(screen.queryByText("No Gitea account yet")).not.toBeInTheDocument()
  })

  it("shows an empty Gitea section when nothing is configured for it", async () => {
    mockGetGitHubAccounts.mockResolvedValue({ accounts: [] })

    renderWithIntl()

    await waitFor(() =>
      expect(screen.getByText("No Gitea account yet")).toBeInTheDocument()
    )
  })
})

describe("VersionControlSettings worktree section", () => {
  it("hosts the worktree location section", async () => {
    vi.clearAllMocks()
    mockDetectGit.mockResolvedValue({
      installed: true,
      version: "git version 2.39.0",
      path: "/usr/bin/git",
    })
    mockGetGitSettings.mockResolvedValue({ custom_path: null })
    mockGetGitHubAccounts.mockResolvedValue({ accounts: [] })

    renderWithIntl()

    await waitFor(() =>
      expect(screen.getByTestId("worktree-location")).toBeInTheDocument()
    )
  })
})

describe("VersionControlSettings account changes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDetectGit.mockResolvedValue({
      installed: true,
      version: "git version 2.39.0",
      path: "/usr/bin/git",
    })
    mockGetGitSettings.mockResolvedValue({ custom_path: null })
  })

  // An account the credential prompt (or another window) added after the
  // page loaded is not dropped by a change made on the page.
  it("keeps an account added since the page loaded", async () => {
    const first = account({ id: "acc-1", username: "feitao" })
    const added = account({ id: "acc-2", username: "later" })
    mockGetGitHubAccounts.mockResolvedValueOnce({ accounts: [first] })
    mockGetGitHubAccounts.mockResolvedValue({ accounts: [first, added] })
    mockUpdateGitHubAccounts.mockImplementation(async (s) => s)

    renderWithIntl()
    const button = await screen.findByText("Set Default")
    fireEvent.click(button)

    await waitFor(() => expect(mockUpdateGitHubAccounts).toHaveBeenCalled())
    const sent = mockUpdateGitHubAccounts.mock.calls[0][0]
    expect(sent.accounts.map((a) => a.id)).toEqual(["acc-1", "acc-2"])
  })

  // A list that cannot be read is not written over with the page's copy.
  it("does not save over a list it could not read", async () => {
    mockGetGitHubAccounts.mockResolvedValueOnce({
      accounts: [account({ id: "acc-1" })],
    })
    mockGetGitHubAccounts.mockRejectedValue(new Error("database is locked"))

    renderWithIntl()
    fireEvent.click(await screen.findByText("Set Default"))

    await waitFor(() => expect(mockGetGitHubAccounts).toHaveBeenCalledTimes(2))
    expect(mockUpdateGitHubAccounts).not.toHaveBeenCalled()
  })

  // 在页面打开时读到的空列表上加 Git 账号：对话框以为这是第一个账号。
  async function addGitAccountFromStalePage(username: string) {
    renderWithIntl()
    const heading = await screen.findByText("Git Accounts")
    const section = heading.closest("section") as HTMLElement
    await screen.findByText("No Git server accounts configured.")
    fireEvent.click(within(section).getByText("Add Account"))
    fireEvent.change(
      await screen.findByPlaceholderText("https://gitlab.example.com"),
      { target: { value: "https://git2.example.test" } }
    )
    fireEvent.change(screen.getByPlaceholderText("Username or email"), {
      target: { value: username },
    })
    fireEvent.change(screen.getByPlaceholderText("Password or access token"), {
      target: { value: "x2" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(mockUpdateGitHubAccounts).toHaveBeenCalled())
    return mockUpdateGitHubAccounts.mock.calls[0][0].accounts
  }

  // 别的标签页刚加的默认账号，不会被没刷新的页面加的新账号抢走默认。
  it("keeps the stored default when a stale page adds another account", async () => {
    const qaOne = account({
      id: "acc-1",
      username: "qa-one",
      server_url: "https://git.example.test",
      provider: undefined,
      is_default: true,
    })
    mockGetGitHubAccounts.mockResolvedValueOnce({ accounts: [] })
    mockGetGitHubAccounts.mockResolvedValue({ accounts: [qaOne] })
    mockUpdateGitHubAccounts.mockImplementation(async (s) => s)

    const sent = await addGitAccountFromStalePage("qa-two")
    expect(sent.map((a) => [a.username, a.is_default])).toEqual([
      ["qa-one", true],
      ["qa-two", false],
    ])
  })

  // 存着的列表里还没有默认账号时，新加的账号成为默认。
  it("makes the new account the default when none is stored", async () => {
    mockGetGitHubAccounts.mockResolvedValue({ accounts: [] })
    mockUpdateGitHubAccounts.mockImplementation(async (s) => s)

    const sent = await addGitAccountFromStalePage("qa-two")
    expect(sent.map((a) => [a.username, a.is_default])).toEqual([
      ["qa-two", true],
    ])
  })
})

describe("VersionControlSettings read failure", () => {
  const T = enMessages.VersionControlSettings
  const retry = enMessages.SystemSettings.retry

  beforeEach(() => {
    vi.clearAllMocks()
    mockDetectGit.mockResolvedValue({
      installed: true,
      version: "git version 2.39.0",
      path: "/opt/git/bin/git",
    })
    mockGetGitHubAccounts.mockResolvedValue({ accounts: [] })
  })

  /// Regression (#628): a failed read left the path field empty and every
  /// account list reading "no accounts", with only a passing toast; saving
  /// the path then wrote the real custom git path back as empty.
  it("locks the git path and says the lists failed until a retry succeeds", async () => {
    mockGetGitSettings.mockRejectedValueOnce(new Error("backend down"))

    renderWithIntl()

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("backend down")
    // An unread detection is not reported as "git not found".
    expect(screen.queryByText(T.gitNotFound)).not.toBeInTheDocument()
    // The account sections say the read failed instead of "no accounts".
    expect(screen.queryByText(T.noAccounts)).not.toBeInTheDocument()
    expect(screen.queryByText(T.gitAccount.noAccounts)).not.toBeInTheDocument()
    expect(
      screen.getAllByText(/Failed to load settings: backend down/)
    ).toHaveLength(6)
    // Every write is out of reach: path editing and every add button.
    expect(screen.getByRole("button", { name: T.customGitPath })).toBeDisabled()
    // GitHub, GitLab, Gitea, CNB and plain git each have one.
    const adds = screen.getAllByRole("button", { name: T.addAccount })
    expect(adds).toHaveLength(5)
    for (const button of adds) expect(button).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: T.customGitPath }))
    expect(screen.queryByPlaceholderText(T.customGitPathPlaceholder)).toBeNull()

    mockGetGitSettings.mockResolvedValueOnce({
      custom_path: "/opt/git/bin/git",
    })
    fireEvent.click(within(alert).getByRole("button", { name: retry }))

    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    )
    expect(await screen.findByText(T.noAccounts)).toBeInTheDocument()
    const edit = screen.getByRole("button", { name: T.customGitPath })
    expect(edit).toBeEnabled()
    fireEvent.click(edit)
    const input = screen.getByPlaceholderText(T.customGitPathPlaceholder)
    expect(input).toHaveValue("/opt/git/bin/git")
    expect(mockUpdateGitSettings).not.toHaveBeenCalled()

    mockTestGitPath.mockResolvedValue({
      installed: true,
      version: "git version 2.39.0",
      path: "/opt/git/bin/git",
    })
    mockUpdateGitSettings.mockResolvedValue({ custom_path: "/opt/git/bin/git" })
    fireEvent.click(screen.getByRole("button", { name: T.save }))
    await waitFor(() =>
      expect(mockUpdateGitSettings).toHaveBeenCalledWith({
        custom_path: "/opt/git/bin/git",
      })
    )
  })
})

describe("VersionControlSettings plain git account test", () => {
  const T = enMessages.VersionControlSettings
  const plain = account({
    id: "acc-git",
    server_url: "https://git.invalid",
    username: "qa-user",
    provider: undefined,
    scopes: [],
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockDetectGit.mockResolvedValue({
      installed: true,
      version: "git version 2.39.0",
      path: "/usr/bin/git",
    })
    mockGetGitSettings.mockResolvedValue({ custom_path: null })
    mockGetGitHubAccounts.mockResolvedValue({ accounts: [plain] })
    vi.mocked(getAccountToken).mockResolvedValue("secret")
  })

  async function clickTest() {
    renderWithIntl()
    const heading = await screen.findByText(T.gitAccount.sectionTitle)
    const section = heading.closest("section") as HTMLElement
    fireEvent.click(
      await within(section).findByRole("button", { name: T.testConnection })
    )
  }

  // 回归 #1049：普通 Git 账号点「测试」不连服务器，钥匙串里有令牌就报「连接成功」。
  it("reports why the server could not be reached", async () => {
    vi.mocked(probeGitServer).mockResolvedValue({
      success: false,
      username: null,
      scopes: [],
      avatar_url: null,
      message: "dns error: no such host",
    })

    await clickTest()

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(probeGitServer).toHaveBeenCalledWith("https://git.invalid")
    expect(toast.error).toHaveBeenCalledWith(
      "Connection failed: dns error: no such host"
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("says the server is reachable but the token cannot be checked", async () => {
    vi.mocked(probeGitServer).mockResolvedValue({
      success: true,
      username: null,
      scopes: [],
      avatar_url: null,
      message: null,
    })

    await clickTest()

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(T.gitAccount.serverReachable)
    )
    expect(toast.success).not.toHaveBeenCalledWith(T.connectionSuccess)
  })
})
