import { fireEvent, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const h = vi.hoisted(() => ({
  hideDesktopOnly: false,
  setRoute: vi.fn(),
  focusCategory: vi.fn(),
}))

vi.mock("@/hooks/use-hide-desktop-only", () => ({
  useHideDesktopOnly: () => h.hideDesktopOnly,
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useOptionalWorkbenchRoute: () => ({ setRoute: h.setRoute }),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ allFolders: [{ id: 1, kind: "project", parent_id: null }] }),
}))
vi.mock("@/stores/conversation-taxonomy-store", () => ({
  useConversationTaxonomySync: () => {},
  useConversationTaxonomyStore: (selector: (s: unknown) => unknown) =>
    selector({ byFolder: { 1: { taxonomy: {} } } }),
}))
vi.mock("@/stores/mindmap-view-store", () => ({
  useMindMapViewStore: (selector: (s: unknown) => unknown) =>
    selector({ focusCategory: h.focusCategory }),
}))
vi.mock("@/components/canvas/mindmap/mindmap-model", () => ({
  categoryPath: () => [
    { id: "c1", name: "后端" },
    { id: "c2", name: "接口" },
  ],
}))

import { ConversationMindMapTrail } from "./conversation-mindmap-trail"

function renderTrail() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ConversationMindMapTrail conversationId={7} folderId={1} />
    </NextIntlClientProvider>
  )
}

describe("ConversationMindMapTrail", () => {
  beforeEach(() => {
    h.hideDesktopOnly = false
    h.setRoute.mockClear()
    h.focusCategory.mockClear()
  })

  it("宽屏下路径可以点进画布", () => {
    const { getByText } = renderTrail()
    fireEvent.click(getByText("接口"))
    expect(h.setRoute).toHaveBeenCalledWith("canvas")
  })

  // #1335：画布手机上不做，路径照旧显示，但不再是进画布的入口
  it("手机上路径只显示文字，不能点进画布", () => {
    h.hideDesktopOnly = true
    const { getByText, queryAllByRole } = renderTrail()
    expect(getByText("后端")).toBeTruthy()
    expect(queryAllByRole("button")).toHaveLength(0)
    fireEvent.click(getByText("接口"))
    expect(h.setRoute).not.toHaveBeenCalled()
  })
})
