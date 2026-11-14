import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { HostDevices, LendingDevice } from "@/lib/cowork/host-choice"

const env = vi.hoisted(() => ({
  /** The window's server. */
  call: vi.fn(),
  /** The app itself. */
  shellCall: vi.fn(),
  desktop: true,
  remote: true,
  serverInfo: null as ((info: { features: string[] }) => void) | null,
}))
vi.mock("@/lib/transport", () => ({
  getShellTransport: () => ({ call: env.shellCall }),
  getTransport: () => ({
    call: env.call,
    onServerInfo: (callback: (info: { features: string[] }) => void) => {
      env.serverInfo = callback
      return () => {
        env.serverInfo = null
      }
    },
  }),
  isDesktop: () => env.desktop,
  isRemoteDesktopMode: () => env.remote,
}))

import { StatusBarHostChoice } from "./status-bar-host-choice"

const MINI = "mini-0123456789"
const BOOK = "book-0123456789"

function device(over: Partial<LendingDevice> & { id: string | null }) {
  return {
    key: over.id ?? "host-9",
    name: "",
    browser: false,
    chrome: false,
    shell: false,
    ...over,
  } satisfies LendingDevice
}

const BOTH: LendingDevice[] = [
  device({ id: MINI, name: "Mac mini", browser: true }),
  device({
    id: BOOK,
    name: "MacBook",
    browser: true,
    chrome: true,
    shell: true,
  }),
]

function devices(over: Partial<HostDevices> = {}): HostDevices {
  return {
    devices: BOTH,
    choices: { browser: null, shell: null },
    browserNow: BOOK,
    shellNow: BOOK,
    ...over,
  }
}

/** A server that answers `current`, and takes a choice the way the real one
 *  does: fixed, calls go to that computer if it lends the thing. */
function server(initial: HostDevices) {
  let current = initial
  env.call.mockImplementation(
    async (
      command: string,
      args: { capability?: "browser" | "shell"; deviceId?: string | null }
    ) => {
      if (command === "get_host_devices") return current
      if (command === "set_host_choice" && args.capability) {
        const picked = current.devices.find((d) => d.id === args.deviceId)
        const pin = picked?.id ? { id: picked.id, name: picked.name } : null
        const goesTo = picked ? picked.key : BOOK
        current =
          args.capability === "browser"
            ? {
                ...current,
                choices: { ...current.choices, browser: pin },
                browserNow: goesTo,
              }
            : {
                ...current,
                choices: { ...current.choices, shell: pin },
                shellNow: goesTo,
              }
        return current
      }
      throw new Error(`unexpected ${command}`)
    }
  )
}

async function mount(features = ["host_bridge_ws", "host_choice"]) {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <StatusBarHostChoice />
      </NextIntlClientProvider>
    )
  })
  await act(async () => {
    env.serverInfo?.({ features })
  })
  return result
}

const trigger = () =>
  screen.getByRole("button", { name: "Which computer agents use" })

async function openPanel() {
  await userEvent.click(trigger())
}

beforeEach(() => {
  env.call.mockReset()
  env.shellCall.mockReset().mockResolvedValue({ id: BOOK, name: "MacBook" })
  env.desktop = true
  env.remote = true
  env.serverInfo = null
})

describe("StatusBarHostChoice", () => {
  it("is not there in a local window, whose agents are on this computer", async () => {
    env.remote = false
    server(devices())
    const { container } = await mount()
    expect(container).toBeEmptyDOMElement()
    expect(env.call).not.toHaveBeenCalled()
  })

  it("is not there for a server that cannot be asked", async () => {
    server(devices())
    const { container } = await mount(["host_bridge_ws"])
    expect(container).toBeEmptyDOMElement()
    expect(env.call).not.toHaveBeenCalled()
  })

  it("is not there while no computer is connected and nothing is fixed", async () => {
    server(devices({ devices: [], browserNow: null, shellNow: null }))
    const { container } = await mount()
    await waitFor(() => expect(env.call).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("lists the computers, what each lends, and where calls go now", async () => {
    server(devices())
    await mount()
    await waitFor(() => expect(trigger()).toBeInTheDocument())
    expect(trigger()).toHaveAttribute("data-host-choice-away", "false")
    await openPanel()

    const mini = document.querySelector(
      `[data-host-choice-device="${MINI}"]`
    ) as HTMLElement
    expect(within(mini).getByText("Mac mini")).toBeInTheDocument()
    expect(within(mini).getByText("Browser")).toBeInTheDocument()
    expect(within(mini).queryByText("This computer")).toBeNull()
    const book = document.querySelector(
      `[data-host-choice-device="${BOOK}"]`
    ) as HTMLElement
    expect(
      within(book).getByText("Browser · Chrome · Command line")
    ).toBeInTheDocument()
    // The app says which of them it is on.
    expect(env.shellCall).toHaveBeenCalledWith("host_device")
    expect(within(book).getByText("This computer")).toBeInTheDocument()

    const browser = document.querySelector(
      '[data-host-choice="browser"]'
    ) as HTMLElement
    expect(within(browser).getByText("Now: MacBook")).toBeInTheDocument()
    expect(
      within(browser).getByText(/Automatic: the computer where you turned on/)
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Browser · Automatic" })
    ).toBeInTheDocument()
  })

  it("fixes the browser to a computer, and frees it again", async () => {
    server(devices())
    await mount()
    await waitFor(() => expect(trigger()).toBeInTheDocument())
    await openPanel()
    await userEvent.click(
      screen.getByRole("button", { name: "Browser · Automatic" })
    )
    await userEvent.click(screen.getByRole("menuitem", { name: "Mac mini" }))
    expect(env.call).toHaveBeenCalledWith("set_host_choice", {
      capability: "browser",
      deviceId: MINI,
    })
    const browser = document.querySelector(
      '[data-host-choice="browser"]'
    ) as HTMLElement
    await waitFor(() =>
      expect(within(browser).getByText("Now: Mac mini")).toBeInTheDocument()
    )
    // Fixed: the rule for "automatic" no longer applies, so it is not said.
    expect(within(browser).queryByText(/Automatic: the computer/)).toBeNull()
    // The command line was not touched.
    expect(
      screen.getByRole("button", {
        name: "Command line (ssh desktop) · Automatic",
      })
    ).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole("button", { name: "Browser · Mac mini" })
    )
    await userEvent.click(screen.getByRole("menuitem", { name: "Automatic" }))
    expect(env.call).toHaveBeenLastCalledWith("set_host_choice", {
      capability: "browser",
      deviceId: null,
    })
    await waitFor(() =>
      expect(within(browser).getByText("Now: MacBook")).toBeInTheDocument()
    )
  })

  it("turns amber and says so while a fixed computer is away", async () => {
    server(
      devices({
        devices: [BOTH[1]],
        choices: { browser: { id: MINI, name: "Mac mini" }, shell: null },
        browserNow: null,
      })
    )
    await mount()
    await waitFor(() =>
      expect(trigger()).toHaveAttribute("data-host-choice-away", "true")
    )
    expect(trigger()).toHaveAttribute(
      "title",
      "A computer you fixed is not connected"
    )
    await openPanel()
    const browser = document.querySelector(
      '[data-host-choice="browser"]'
    ) as HTMLElement
    expect(browser).toHaveAttribute("data-away", "true")
    expect(
      within(browser).getByText(/Fixed to Mac mini, which does not lend this/)
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Browser · Mac mini (not connected)" })
    ).toBeInTheDocument()
    expect(
      document.querySelector('[data-host-choice="shell"]')
    ).toHaveAttribute("data-away", "false")
  })

  it("stays, with nothing connected, while something is still fixed", async () => {
    server(
      devices({
        devices: [],
        choices: { browser: null, shell: { id: MINI, name: "Mac mini" } },
        browserNow: null,
        shellNow: null,
      })
    )
    await mount()
    await waitFor(() =>
      expect(trigger()).toHaveAttribute("data-host-choice-away", "true")
    )
    await openPanel()
    expect(
      screen.getByText("No computer is connected right now.")
    ).toBeInTheDocument()
    // The way back to "automatic" is still there.
    await userEvent.click(
      screen.getByRole("button", {
        name: "Command line (ssh desktop) · Mac mini (not connected)",
      })
    )
    expect(
      screen.getByRole("menuitem", { name: "Automatic" })
    ).not.toHaveAttribute("data-disabled")
  })

  it("lists an app too old to name its computer, without offering to fix on it", async () => {
    server(
      devices({
        devices: [
          device({ id: null, browser: true }),
          device({ id: BOOK, name: "MacBook", shell: true }),
        ],
        browserNow: "host-9",
      })
    )
    await mount()
    await waitFor(() => expect(trigger()).toBeInTheDocument())
    await openPanel()
    const old = document.querySelector(
      '[data-host-choice-device="host-9"]'
    ) as HTMLElement
    expect(within(old).getByText("Unnamed computer")).toBeInTheDocument()
    expect(
      within(old).getByText("Update dodoer there to be able to fix on it")
    ).toBeInTheDocument()
    const browser = document.querySelector(
      '[data-host-choice="browser"]'
    ) as HTMLElement
    expect(
      within(browser).getByText("Now: Unnamed computer")
    ).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole("button", { name: "Browser · Automatic" })
    )
    expect(
      screen.queryByRole("menuitem", { name: "Unnamed computer" })
    ).toBeNull()
    expect(
      screen.getByRole("menuitem", { name: "MacBook" })
    ).toBeInTheDocument()
  })

  it("says why a choice was not taken, and keeps the old one", async () => {
    server(devices())
    await mount()
    await waitFor(() => expect(trigger()).toBeInTheDocument())
    await openPanel()
    env.call.mockImplementation(async (command: string) => {
      if (command === "get_host_devices") return devices()
      throw new Error("That computer is not connected")
    })
    await userEvent.click(
      screen.getByRole("button", { name: "Browser · Automatic" })
    )
    await userEvent.click(screen.getByRole("menuitem", { name: "Mac mini" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not change it: That computer is not connected"
    )
    expect(
      screen.getByRole("button", { name: "Browser · Automatic" })
    ).toBeInTheDocument()
  })

  it("works from a browser too, where no app says which computer this is", async () => {
    env.desktop = false
    env.remote = false
    server(devices())
    await mount()
    await waitFor(() => expect(trigger()).toBeInTheDocument())
    expect(env.shellCall).not.toHaveBeenCalled()
    await openPanel()
    expect(screen.queryByText("This computer")).toBeNull()
  })
})
