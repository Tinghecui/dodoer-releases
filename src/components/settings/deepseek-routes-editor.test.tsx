import {
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  canSaveDeepSeekRoutes,
  DEEPSEEK_ROUTES_EXAMPLE,
  DeepSeekRoutesEditor,
} from "./deepseek-routes-editor"
import { loadDeepSeekRoutes, updateDeepSeekRoutes } from "@/lib/api"
import enMessages from "@/i18n/messages/en.json"
import type { DeepSeekRoutes } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  loadDeepSeekRoutes: vi.fn(),
  updateDeepSeekRoutes: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const STORED = "providers:\n  gw:\n    api: openai-responses\n"

function routes(patch: Partial<DeepSeekRoutes> = {}): DeepSeekRoutes {
  return {
    path: "/home/u/.dsh/deepseek-acp/settings.yaml",
    exists: true,
    yaml: STORED,
    importedFrom: null,
    error: null,
    ...patch,
  }
}

async function renderEditor(next: DeepSeekRoutes) {
  vi.mocked(loadDeepSeekRoutes).mockResolvedValue(next)
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DeepSeekRoutesEditor />
    </NextIntlClientProvider>
  )
  await waitForElementToBeRemoved(() =>
    screen.queryByText(/Reading the settings document/i)
  )
}

const saveButton = () => screen.getByRole("button", { name: /Save routes/i })

beforeEach(() => {
  vi.mocked(loadDeepSeekRoutes).mockReset()
  vi.mocked(updateDeepSeekRoutes).mockReset()
  vi.mocked(updateDeepSeekRoutes).mockResolvedValue(undefined)
})

describe("canSaveDeepSeekRoutes", () => {
  it("offers a save only for a change, or to copy imported routes", () => {
    expect(canSaveDeepSeekRoutes(null, "", false)).toBe(false)
    expect(canSaveDeepSeekRoutes(routes(), STORED, false)).toBe(false)
    expect(canSaveDeepSeekRoutes(routes(), "", false)).toBe(true)
    expect(canSaveDeepSeekRoutes(routes(), "", true)).toBe(false)
    // Unchanged imported text is still worth saving: it moves the routes into
    // the agent's own document.
    expect(
      canSaveDeepSeekRoutes(
        routes({ exists: false, importedFrom: "/home/u/.dsh/settings.yaml" }),
        STORED,
        false
      )
    ).toBe(true)
    expect(
      canSaveDeepSeekRoutes(routes({ error: "broken" }), "x: 1\n", false)
    ).toBe(false)
  })
})

describe("DeepSeekRoutesEditor", () => {
  it("shows the stored section and saves the edited text", async () => {
    const user = userEvent.setup()
    await renderEditor(routes())
    const box = screen.getByLabelText(
      "Extra model routes"
    ) as HTMLTextAreaElement
    expect(box.value).toBe(STORED)
    expect(saveButton()).toBeDisabled()

    vi.mocked(loadDeepSeekRoutes).mockResolvedValue(routes({ yaml: "" }))
    await user.clear(box)
    await user.click(saveButton())
    await waitFor(() => expect(updateDeepSeekRoutes).toHaveBeenCalledWith(""))
  })

  it("inserts the example into an empty box, without a key in it", async () => {
    const user = userEvent.setup()
    await renderEditor(routes({ exists: false, yaml: "" }))
    await user.click(screen.getByRole("button", { name: /Insert example/i }))
    const box = screen.getByLabelText(
      "Extra model routes"
    ) as HTMLTextAreaElement
    expect(box.value).toBe(DEEPSEEK_ROUTES_EXAMPLE)
    expect(DEEPSEEK_ROUTES_EXAMPLE).toContain("apiKeyEnv:")
    expect(DEEPSEEK_ROUTES_EXAMPLE).not.toMatch(/\bapiKey:/)
  })

  it("names the older document routes are imported from", async () => {
    await renderEditor(
      routes({ exists: false, importedFrom: "/home/u/.dsh/settings.yaml" })
    )
    expect(screen.getByText("/home/u/.dsh/settings.yaml")).toBeInTheDocument()
    expect(saveButton()).toBeEnabled()
  })

  it("refuses to edit a document it cannot read", async () => {
    await renderEditor(routes({ error: "could not parse" }))
    expect(screen.getByText("could not parse")).toBeInTheDocument()
    expect(screen.queryByLabelText("Extra model routes")).toBeNull()
  })
})
