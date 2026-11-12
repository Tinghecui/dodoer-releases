import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  call: vi.fn(),
  notify: vi.fn(),
  desktop: false,
  remote: false,
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: env.call }),
}))
vi.mock("@/lib/notify", () => ({ notify: env.notify }))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => env.desktop,
  isRemoteDesktopWindow: () => env.remote,
}))

import { resetSystemResourcesForTests } from "@/lib/cowork/resources"
import { ResourceMeter } from "./resource-meter"

const GIB = 1024 ** 3

function raw(overrides: Record<string, unknown> = {}) {
  return {
    sampled_at: 1_700_000_000_000,
    cpu: { usage_percent: 12.4, cores: 8, load_average: [0.52, 1.04, 2.1] },
    memory: { total_bytes: 8 * GIB, available_bytes: 2 * GIB },
    swap: { total_bytes: 4 * GIB, used_bytes: GIB },
    disk: {
      path: "/home/ann",
      total_bytes: 100 * GIB,
      available_bytes: 40 * GIB,
    },
    workspace: null,
    memory_pressure: "normal",
    ...overrides,
  }
}

function renderMeter(locale: "en" | "zh-CN" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      <ResourceMeter />
    </NextIntlClientProvider>
  )
}

const q = (sel: string) => document.querySelector(sel)
const rows = () =>
  [...document.querySelectorAll("[data-resource-row]")].map(
    (row) => row.textContent
  )

beforeEach(() => {
  env.call.mockReset()
  env.notify.mockReset()
  env.desktop = false
  env.remote = false
  resetSystemResourcesForTests()
})

afterEach(() => {
  resetSystemResourcesForTests()
})

describe("ResourceMeter", () => {
  it("renders nothing until there is a reading, or when there never is one", async () => {
    env.call.mockRejectedValue({ code: "not_implemented", message: "x" })
    renderMeter()
    expect(q("[data-resource-meter]")).toBeNull()
    await vi.waitFor(() => expect(env.call).toHaveBeenCalledTimes(1))
    expect(q("[data-resource-meter]")).toBeNull()
  })

  it("shows memory at a glance and says the rest in its label", async () => {
    env.call.mockResolvedValue(raw())
    renderMeter()
    const button = await screen.findByRole("button", {
      name: "System resources (Server) · CPU 12% · Memory 75%",
    })
    expect(button).toHaveTextContent("75%")
    expect(button).toHaveAttribute("data-pressure", "normal")
    expect(button.querySelector("svg")).toBeNull()
    expect(env.notify).not.toHaveBeenCalled()
  })

  it("opens to CPU, memory, swap and disk", async () => {
    env.call.mockResolvedValue(raw())
    renderMeter()
    await userEvent.click(await screen.findByRole("button"))
    expect(await screen.findByText("Normal")).toBeInTheDocument()
    expect(rows()).toEqual([
      "CPU12%8 cores · load 0.52 / 1.04 / 2.10",
      "Memory6.0 / 8.0 GB2.0 GB available",
      "Swap1.0 / 4.0 GB",
      "Disk60.0 / 100 GB40.0 GB free · /home/ann",
    ])
  })

  it("speaks the workspace's language", async () => {
    env.call.mockResolvedValue(raw())
    renderMeter("zh-CN")
    expect(
      await screen.findByRole("button", {
        name: "资源占用 (服务器) · CPU 12% · 内存 75%",
      })
    ).toBeInTheDocument()
  })

  it("is this computer's in the local desktop workspace", async () => {
    env.desktop = true
    env.call.mockResolvedValue(raw())
    renderMeter()
    expect(
      await screen.findByRole("button", { name: /\(This computer\)/ })
    ).toBeInTheDocument()
  })

  it("warns with a sign as well as a colour when memory is tight", async () => {
    env.call.mockResolvedValue(
      raw({
        memory: { total_bytes: 8 * GIB, available_bytes: GIB },
        memory_pressure: "warning",
      })
    )
    renderMeter()
    const button = await screen.findByRole("button", {
      name: "System resources (Server) · CPU 12% · Memory 88% · Tight",
    })
    expect(button).toHaveAttribute("data-pressure", "warning")
    expect(button.querySelector("svg")).not.toBeNull()
    // Tight is not yet worth interrupting for.
    expect(env.notify).not.toHaveBeenCalled()
    await userEvent.click(button)
    expect(await screen.findByText(/getting tight/)).toBeInTheDocument()
    expect(q("[data-resource-pressure]")).toHaveTextContent("Tight")
  })

  it("raises one notification when memory is almost full", async () => {
    env.call.mockResolvedValue(
      raw({
        memory: { total_bytes: 8 * GIB, available_bytes: GIB / 4 },
        memory_pressure: "critical",
      })
    )
    const view = renderMeter()
    await screen.findByRole("button", { name: /Almost full/ })
    expect(env.notify).toHaveBeenCalledTimes(1)
    expect(env.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        key: "cowork-memory-pressure",
        title: "Memory is almost full",
        description: expect.stringContaining("Server: 256 MB left of 8.0 GB."),
      })
    )
    // Mounted again in the same episode (the sidebar collapsing moves the
    // meter into the capsule): no second toast.
    view.unmount()
    renderMeter()
    await screen.findByRole("button", { name: /Almost full/ })
    expect(env.notify).toHaveBeenCalledTimes(1)
  })

  it("shows the workspace's own memory and the limit it runs under", async () => {
    env.call.mockResolvedValue(
      raw({
        workspace: {
          used_bytes: 3 * GIB,
          limit: { limit_bytes: 4 * GIB, used_bytes: 3.8 * GIB },
        },
        memory_pressure: "critical",
      })
    )
    renderMeter()
    // The limit is closer to full than the machine: it is the headline.
    const button = await screen.findByRole("button", {
      name: /Memory 95% · Almost full/,
    })
    expect(env.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("205 MB left of 4.0 GB"),
      })
    )
    await userEvent.click(button)
    await screen.findByText("This workspace")
    expect(rows()).toContain(
      "This workspace3.0 GBIts own processes: agents, terminals, builds"
    )
    expect(rows()).toContain("Memory limit3.8 / 4.0 GB")
  })
})
