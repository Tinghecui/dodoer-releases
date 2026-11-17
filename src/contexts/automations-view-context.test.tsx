import { act, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Automation } from "@/lib/types"

const listMock = vi.fn()
let changedHandler: (() => void) | null = null

vi.mock("@/lib/api", () => ({
  automationList: (...args: unknown[]) => listMock(...args),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((channel: string, cb: () => void) => {
    if (channel === "automation://changed") changedHandler = cb
    return Promise.resolve(() => {
      changedHandler = null
    })
  }),
  onTransportReconnect: vi.fn(() => () => {}),
}))

import {
  AutomationsViewProvider,
  useAutomationsView,
} from "./automations-view-context"

const sample = (id: number) => ({ id, unseen_failures: 0 }) as Automation

function Probe() {
  const { automations, error, loaded, refetch } = useAutomationsView()
  return (
    <div>
      <span data-testid="count">{automations.length}</span>
      <span data-testid="loaded">{String(loaded)}</span>
      <span data-testid="error">{error ?? ""}</span>
      <button type="button" onClick={() => void refetch()}>
        retry
      </button>
    </div>
  )
}

beforeEach(() => {
  listMock.mockReset()
  changedHandler = null
})

describe("AutomationsViewProvider", () => {
  it("reports a failed first fetch, clears it on a good retry, and keeps a loaded list through a later failure (#339)", async () => {
    listMock.mockRejectedValueOnce(new Error("HTTP 500"))
    render(
      <AutomationsViewProvider>
        <Probe />
      </AutomationsViewProvider>
    )
    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toBe("HTTP 500")
    )
    expect(screen.getByTestId("count").textContent).toBe("0")

    listMock.mockResolvedValueOnce([sample(1), sample(2)])
    await act(async () => {
      screen.getByRole("button", { name: "retry" }).click()
    })
    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("2")
    )
    expect(screen.getByTestId("error").textContent).toBe("")

    // 已经加载过：瞬时失败保留旧列表，不报错。
    listMock.mockRejectedValueOnce(new Error("HTTP 502"))
    await act(async () => {
      changedHandler?.()
    })
    expect(screen.getByTestId("count").textContent).toBe("2")
    expect(screen.getByTestId("error").textContent).toBe("")
  })

  it("reports not-loaded until the first list arrives, then loaded (#541)", async () => {
    let resolve: (list: Automation[]) => void = () => {}
    listMock.mockReturnValueOnce(
      new Promise<Automation[]>((r) => {
        resolve = r
      })
    )
    render(
      <AutomationsViewProvider>
        <Probe />
      </AutomationsViewProvider>
    )
    expect(screen.getByTestId("loaded").textContent).toBe("false")
    await act(async () => {
      resolve([sample(1)])
    })
    expect(screen.getByTestId("loaded").textContent).toBe("true")
    expect(screen.getByTestId("count").textContent).toBe("1")
  })
})
