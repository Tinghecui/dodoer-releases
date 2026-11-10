import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const openUrl = vi.fn<(url: string) => Promise<void>>(async () => {})
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  openUrl: (url: string) => openUrl(url),
}))
vi.mock("@/components/agent-icon", () => ({
  AgentIcon: () => null,
}))

import { SidebarPrDetails, SidebarPrIndicator } from "./sidebar-pr-status"
import { SidebarConversationHoverDetails } from "./sidebar-conversation-hover-details"
import { applyPrStatuses, usePrStatusStore } from "@/stores/pr-status-store"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import type {
  DbConversationSummary,
  FolderDetail,
  FolderPrStatus,
  PrHint,
} from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

function hint(overrides: Partial<PrHint> = {}): FolderPrStatus {
  return {
    kind: "pr",
    provider: "github",
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    state: "open",
    draft: false,
    branch: "feat",
    base_ref: "main",
    mergeable: null,
    merge_state: null,
    review_decision: null,
    checks: {
      available: true,
      total: 4,
      success: 2,
      failure: 0,
      neutral: 0,
      pending: 2,
    },
    ...overrides,
  }
}

function withIntl(node: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  usePrStatusStore.setState({ byFolder: new Map(), enabled: true })
  openUrl.mockClear()
})

afterEach(() => cleanup())

describe("SidebarPrIndicator", () => {
  it("shows the number, state and a running pie for an open pull request", () => {
    applyPrStatuses([{ folder_id: 3, status: hint() }])
    const { container } = withIntl(<SidebarPrIndicator folderId={3} />)
    expect(screen.getByText("#42")).toBeTruthy()
    expect(container.querySelector('[data-pr-indicator="open"]')).not.toBeNull()
    expect(
      container.querySelector('[data-checks-glyph="running"]')
    ).not.toBeNull()
    expect(
      screen.getByText("Pull request #42, Open, checks running, 2 of 4 done")
    ).toBeTruthy()
  })

  it("marks drafts and drops the checks once merged", () => {
    applyPrStatuses([
      { folder_id: 3, status: hint({ draft: true }) },
      { folder_id: 4, status: hint({ state: "merged" }) },
    ])
    const { container } = withIntl(
      <>
        <SidebarPrIndicator folderId={3} />
        <SidebarPrIndicator folderId={4} />
      </>
    )
    expect(
      container.querySelector('[data-pr-indicator="draft"]')
    ).not.toBeNull()
    expect(
      container.querySelector('[data-pr-indicator="merged"]')
    ).not.toBeNull()
    expect(container.querySelectorAll("[data-checks-glyph]")).toHaveLength(1)
  })

  it("draws nothing without a pull request, or with the toggle off", () => {
    applyPrStatuses([
      { folder_id: 3, status: { kind: "no_pr", branch: "feat" } },
      { folder_id: 4, status: hint() },
    ])
    const { container } = withIntl(<SidebarPrIndicator folderId={3} />)
    expect(container.innerHTML).toBe("")
    cleanup()
    usePrStatusStore.setState({ enabled: false })
    const second = withIntl(<SidebarPrIndicator folderId={4} />)
    expect(second.container.innerHTML).toBe("")
  })
})

describe("SidebarPrDetails", () => {
  it("links to the pull request with review, checks and conflicts", () => {
    applyPrStatuses([
      {
        folder_id: 3,
        status: hint({
          review_decision: "changes_requested",
          mergeable: false,
          checks: {
            available: true,
            total: 3,
            success: 1,
            failure: 1,
            neutral: 0,
            pending: 1,
          },
        }),
      },
    ])
    withIntl(<SidebarPrDetails folderId={3} />)
    expect(screen.getByText("· changes requested")).toBeTruthy()
    expect(screen.getByText("1 passed · 1 failed · 1 running")).toBeTruthy()
    expect(screen.getByText("Has merge conflicts")).toBeTruthy()
    fireEvent.click(screen.getByTitle("Open in browser"))
    expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/app/pull/42")
  })

  it("tells a GitHub user to log in to gh, and others to add an account", () => {
    applyPrStatuses([
      {
        folder_id: 3,
        status: { kind: "no_account", provider: "github", host: "github.com" },
      },
      {
        folder_id: 4,
        status: {
          kind: "no_account",
          provider: "gitlab",
          host: "git.corp.com",
        },
      },
    ])
    withIntl(
      <>
        <SidebarPrDetails folderId={3} />
        <SidebarPrDetails folderId={4} />
      </>
    )
    expect(screen.getByText(/Run gh auth login/)).toBeTruthy()
    expect(
      screen.getByText(/Add a GitLab account for git\.corp\.com/)
    ).toBeTruthy()
  })
})

describe("the hover bubble", () => {
  const CREATED_AT = "2026-03-01T10:00:00.000Z"

  function conv(folderId: number): DbConversationSummary {
    return {
      id: 7,
      folder_id: folderId,
      title: "Wire up the parser",
      title_locked: false,
      agent_type: "claude_code",
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: "feat",
      external_id: null,
      message_count: 3,
      child_count: 0,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      pinned_at: null,
    }
  }

  function folder(id: number, parentId: number | null): FolderDetail {
    return {
      id,
      name: `f${id}`,
      path: `/repo/f${id}`,
      git_branch: null,
      default_agent_type: null,
      last_opened_at: CREATED_AT,
      sort_order: 0,
      color: "inherit",
      parent_id: parentId,
      kind: "regular",
      alias: null,
      group_id: null,
    }
  }

  it("shows the pull request for a worktree conversation only", () => {
    resetAppWorkspaceStore()
    useAppWorkspaceStore.setState({
      allFolders: [folder(1, null), folder(2, 1)],
    })
    applyPrStatuses([
      { folder_id: 1, status: hint({ number: 1 }) },
      { folder_id: 2, status: hint({ number: 2 }) },
    ])
    withIntl(<SidebarConversationHoverDetails conversation={conv(2)} />)
    expect(screen.getByText("#2")).toBeTruthy()
    cleanup()
    withIntl(<SidebarConversationHoverDetails conversation={conv(1)} />)
    expect(screen.queryByText("#1")).toBeNull()
    expect(screen.queryByText("Pull request")).toBeNull()
  })
})
