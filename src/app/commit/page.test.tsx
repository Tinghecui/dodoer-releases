import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest"

const mocks = vi.hoisted(() => ({
  isDesktop: vi.fn(() => false),
  tauriClose: vi.fn(async () => {}),
  toastSuccess: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("folderId=1"),
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({}),
  isDesktop: mocks.isDesktop,
  getActiveRemoteConnectionId: () => null,
}))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: mocks.tauriClose }),
}))
vi.mock("@/lib/api", () => ({
  getFolder: async () => ({
    id: 1,
    name: "repo",
    path: "/repo",
    parent_id: null,
  }),
}))
vi.mock("@/contexts/remote-connection-context", () => ({
  RemoteConnectionGate: ({ children }: { children: React.ReactNode }) =>
    children,
}))
vi.mock("@/components/layout/app-title-bar", () => ({
  AppTitleBar: () => null,
}))
vi.mock("@/components/ui/app-toaster", () => ({ AppToaster: () => null }))
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }))
vi.mock("@/contexts/git-credential-context", () => ({
  GitCredentialProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}))
vi.mock("@/components/layout/commit-dialog", () => ({
  CommitWorkspace: ({ onCommitted }: { onCommitted: () => void }) => (
    <button onClick={onCommitted}>commit</button>
  ),
}))

import CommitPage from "./page"
import enMessages from "@/i18n/messages/en.json"

let close: MockInstance<() => void>

beforeEach(() => {
  mocks.isDesktop.mockReturnValue(false)
  mocks.tauriClose.mockClear()
  close = vi.spyOn(window, "close").mockImplementation(() => {})
})
afterEach(() => {
  close.mockRestore()
})

const renderPage = () =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CommitPage />
    </NextIntlClientProvider>
  )

describe("commit page", () => {
  it("closes its browser window after a commit, without Tauri", async () => {
    renderPage()
    fireEvent.click(await screen.findByRole("button", { name: "commit" }))
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(mocks.tauriClose).not.toHaveBeenCalled()
  })

  it("closes the Tauri window on desktop", async () => {
    mocks.isDesktop.mockReturnValue(true)
    renderPage()
    fireEvent.click(await screen.findByRole("button", { name: "commit" }))
    await vi.waitFor(() => expect(mocks.tauriClose).toHaveBeenCalledTimes(1))
    expect(close).not.toHaveBeenCalled()
  })
})
