import { act, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  WorkbenchRouteProvider,
  useWorkbenchRoute,
} from "@/contexts/workbench-route-context"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import type { FolderDetail } from "@/lib/types"

import { WorkbenchRouteConversationSync } from "./workbench-route-conversation-sync"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const folder = { id: 1, name: "repo", path: "/repo" } as unknown as FolderDetail

function tab(id: string, conversationId: number) {
  return {
    id,
    kind: "conversation" as const,
    folderId: 1,
    conversationId,
    agentType: "claude_code" as const,
    title: id,
    isPinned: false,
  }
}

function RouteProbe() {
  const route = useWorkbenchRoute()
  return (
    <>
      <div data-testid="route">{route.routeId}</div>
      <button type="button" onClick={() => route.setRoute("tokenUsage")}>
        usage
      </button>
    </>
  )
}

function renderSync() {
  render(
    <WorkbenchRouteProvider>
      <WorkbenchRouteConversationSync />
      <RouteProbe />
    </WorkbenchRouteProvider>
  )
  act(() => screen.getByRole("button", { name: "usage" }).click())
  expect(screen.getByTestId("route").textContent).toBe("tokenUsage")
}

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({ folders: [folder], allFolders: [folder] })
})

describe("WorkbenchRouteConversationSync", () => {
  it("关掉当前标签、焦点落到邻居上时，用量页留着", () => {
    useTabStore.setState({
      rawTabs: [tab("conv-1", 7), tab("conv-2", 8)],
      activeTabId: "conv-2",
    })
    renderSync()
    act(() => {
      useTabStore.getState().closeConversationTab(1, 8, "claude_code")
    })
    expect(useTabStore.getState().activeTabId).toBe("conv-1")
    expect(screen.getByTestId("route").textContent).toBe("tokenUsage")
  })

  it("关掉唯一的标签、补出空白草稿时，用量页留着", () => {
    useTabStore.setState({
      rawTabs: [tab("conv-1", 7)],
      activeTabId: "conv-1",
    })
    renderSync()
    act(() => {
      useTabStore.getState().closeConversationTab(1, 7, "claude_code")
    })
    expect(useTabStore.getState().activeTabId).not.toBe("conv-1")
    expect(screen.getByTestId("route").textContent).toBe("tokenUsage")
  })

  it("切到另一个标签时回到会话视图", () => {
    useTabStore.setState({
      rawTabs: [tab("conv-1", 7), tab("conv-2", 8)],
      activeTabId: "conv-2",
    })
    renderSync()
    act(() => {
      useTabStore.getState().switchTab("conv-1")
    })
    expect(screen.getByTestId("route").textContent).toBe("conversations")
  })

  it("关掉的是别的标签后再切标签，照样回到会话视图（标记不残留）", () => {
    useTabStore.setState({
      rawTabs: [tab("conv-1", 7), tab("conv-2", 8), tab("conv-3", 9)],
      activeTabId: "conv-2",
    })
    renderSync()
    act(() => {
      useTabStore.getState().closeConversationTab(1, 9, "claude_code")
    })
    expect(screen.getByTestId("route").textContent).toBe("tokenUsage")
    act(() => {
      useTabStore.getState().switchTab("conv-1")
    })
    expect(screen.getByTestId("route").textContent).toBe("conversations")
  })
})
