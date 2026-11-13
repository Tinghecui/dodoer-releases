import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { DelegationBinding } from "@/contexts/delegation-context"
import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"

/**
 * The "sub-task finished after this reply" notice (cowork-codeg#173): drawn
 * for a task the reply never saw end once the card model says it has — the
 * live binding, or after a reload the meta the backend injects from the
 * child's row — and for nothing else.
 */

vi.mock("@/hooks/use-delegated-sub-session", () => ({
  useDelegatedSubSession: vi.fn(),
}))

vi.mock("@/contexts/acp-connections-context", async () => {
  const actual = await vi.importActual<
    typeof import("@/contexts/acp-connections-context")
  >("@/contexts/acp-connections-context")
  return {
    ...actual,
    useConnectionStore: () => ({
      subscribeKey: () => () => {},
      getConnection: () => undefined,
    }),
  }
})

const { useDelegatedSubSession } =
  await import("@/hooks/use-delegated-sub-session")
const mockedHook = vi.mocked(useDelegatedSubSession)
const { DelegationSettledNotice } = await import("./delegation-settled-notice")

const TASK = "a68323fc-0000-4000-8000-000000000000"

function bind(binding: Partial<DelegationBinding> | undefined) {
  mockedHook.mockReturnValue({
    binding: binding
      ? {
          parentConnectionId: "p1",
          parentToolUseId: "pt-1",
          childConnectionId: "c1",
          childConversationId: 99,
          agentType: "claude_code",
          status: "running",
          task: null,
          taskId: TASK,
          assistantId: null,
          assistantName: null,
          ...binding,
        }
      : undefined,
    detail: null,
    loading: false,
    error: null,
  })
}

function source(meta: Record<string, unknown> | null = null) {
  const s: DelegationCardSource = {
    parentToolUseId: "pt-1",
    input: JSON.stringify({ agent_type: "claude_code", task: "Append a line" }),
    output: JSON.stringify({ task_id: TASK, status: "running" }),
    errorText: null,
    state: "output-available",
    meta,
  }
  return s
}

function renderNotice(s: DelegationCardSource) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DelegationSettledNotice candidates={[{ source: s, taskId: TASK }]} />
    </NextIntlClientProvider>
  )
}

const notice = () => screen.queryByTestId("delegation-settled-notice")

beforeEach(() => bind(undefined))

describe("DelegationSettledNotice", () => {
  it("says the task finished once the live binding does", () => {
    bind({ status: "ok" })
    renderNotice(source())
    expect(notice()).toHaveAttribute("data-status", "done")
    expect(notice()).toHaveTextContent(
      "Sub-task #a68323fc finished after this reply ended"
    )
  })

  it("says so after a reload, from the meta the backend injects", () => {
    renderNotice(
      source({
        "codeg.delegation": { status: "completed", child_conversation_id: 99 },
      })
    )
    expect(notice()).toHaveAttribute("data-status", "done")
  })

  it("says the task failed", () => {
    bind({ status: "err", errorCode: "child_refusal" })
    renderNotice(source())
    expect(notice()).toHaveAttribute("data-status", "failed")
    expect(notice()).toHaveTextContent("Sub-task #a68323fc failed")
  })

  it("draws nothing while the task still runs, or once the user canceled it", () => {
    bind({ status: "running" })
    const view = renderNotice(source())
    expect(notice()).toBeNull()
    view.unmount()

    // Nothing live or stored: the ack alone says it runs.
    bind(undefined)
    const bare = renderNotice(source())
    expect(notice()).toBeNull()
    bare.unmount()

    bind({ status: "err", errorCode: "canceled" })
    renderNotice(source())
    expect(notice()).toBeNull()
  })
})
