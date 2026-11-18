import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { HostDevice, HostDeviceList } from "@/lib/cowork/host-devices"

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

import { StatusBarDevices, resetDeviceNamePrompt } from "./status-bar-devices"

const IMAC = "imac-0123456789"
const BOOK = "book-0123456789"

function device(over: Partial<HostDevice> & { id: string }): HostDevice {
  return {
    name: "",
    named: true,
    computerName: "",
    model: "",
    kind: "desktop",
    platform: "macos",
    appVersion: "1.7.0",
    firstSeen: 1,
    lastSeen: Date.now(),
    online: true,
    shell: false,
    browser: false,
    chrome: false,
    ...over,
  }
}

const BOTH: HostDevice[] = [
  device({
    id: IMAC,
    name: "desktop",
    computerName: "Study iMac",
    model: "iMac",
    shell: true,
    browser: true,
    chrome: true,
  }),
  device({
    id: BOOK,
    name: "laptop",
    computerName: "",
    model: "MacBook Air",
    kind: "laptop",
    online: false,
    lastSeen: Date.now() - 5 * 60_000,
  }),
]

/** A server keeping `initial`, and changing it the way the real one does. */
function server(initial: HostDeviceList) {
  let current = initial
  env.call.mockImplementation(
    async (command: string, args: { id?: string; name?: string }) => {
      if (command === "list_host_devices") return current
      if (command === "rename_host_device") {
        current = {
          ...current,
          devices: current.devices.map((d) =>
            d.id === args.id
              ? { ...d, name: args.name ?? d.name, named: true }
              : d
          ),
        }
        return current
      }
      if (command === "forget_host_device") {
        current = {
          ...current,
          devices: current.devices.filter((d) => d.id !== args.id),
        }
        return current
      }
      if (command === "stop_host_device") {
        current = {
          ...current,
          devices: current.devices.map((d) =>
            d.id === args.id
              ? { ...d, stopped: true, shell: false, browser: false }
              : d
          ),
        }
        return current
      }
      throw new Error(`unexpected ${command}`)
    }
  )
}

async function mount(features = ["host_bridge_ws", "host_devices"]) {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <StatusBarDevices />
      </NextIntlClientProvider>
    )
  })
  await act(async () => {
    env.serverInfo?.({ features })
  })
  return result
}

const trigger = () => screen.getByRole("button", { name: "Devices" })

function row(id: string) {
  const li = document.querySelector<HTMLElement>(`[data-device="${id}"]`)
  if (!li) throw new Error(`no row for ${id}`)
  return within(li)
}

beforeEach(() => {
  env.call.mockReset()
  env.shellCall.mockReset().mockResolvedValue({ id: IMAC, name: "Study iMac" })
  env.desktop = true
  env.remote = true
  env.serverInfo = null
  resetDeviceNamePrompt()
})

describe("StatusBarDevices", () => {
  it("is not there in a local window, whose agents are on this computer", async () => {
    env.remote = false
    server({ devices: BOTH, unnamedHosts: 0 })
    const { container } = await mount()
    expect(container).toBeEmptyDOMElement()
    expect(env.call).not.toHaveBeenCalled()
  })

  it("is not there before the server keeps a book", async () => {
    server({ devices: BOTH, unnamedHosts: 0 })
    const { container } = await mount(["host_bridge_ws", "host_choice"])
    expect(container).toBeEmptyDOMElement()
    expect(env.call).not.toHaveBeenCalled()
  })

  it("is not there while no computer has connected", async () => {
    server({ devices: [], unnamedHosts: 0 })
    const { container } = await mount()
    await waitFor(() => expect(env.call).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("lists every device: this one, where each is, what it lends", async () => {
    server({ devices: BOTH, unnamedHosts: 1 })
    await mount()
    await userEvent.click(
      await screen.findByRole("button", { name: "Devices" })
    )
    const imac = row(IMAC)
    expect(imac.getByText("desktop")).toBeInTheDocument()
    expect(imac.getByText("This computer")).toBeInTheDocument()
    expect(imac.getByText("Study iMac")).toBeInTheDocument()
    expect(imac.getByText("Online")).toBeInTheDocument()
    expect(
      imac.getByText("Command line · Browser · Chrome")
    ).toBeInTheDocument()
    // Connected: it would be back at once, so it cannot be removed.
    expect(imac.queryByRole("button", { name: "Remove" })).toBeNull()

    const book = row(BOOK)
    expect(book.queryByText("This computer")).toBeNull()
    expect(book.getByText("MacBook Air")).toBeInTheDocument()
    expect(book.getByText("Last online 5 minutes ago")).toBeInTheDocument()
    expect(
      screen.getByText(/1 older CoTeam connected as well/)
    ).toBeInTheDocument()
  })

  it("renames a device, saying first what the server would refuse", async () => {
    server({ devices: BOTH, unnamedHosts: 0 })
    await mount()
    await userEvent.click(
      await screen.findByRole("button", { name: "Devices" })
    )
    await userEvent.click(row(IMAC).getByRole("button", { name: "Rename" }))
    const input = row(IMAC).getByRole("textbox", { name: "Name" })

    await userEvent.clear(input)
    await userEvent.type(input, "two words{Enter}")
    expect(row(IMAC).getByRole("alert")).toHaveTextContent("lowercase letters")
    await userEvent.clear(input)
    await userEvent.type(input, "laptop{Enter}")
    expect(row(IMAC).getByRole("alert")).toHaveTextContent(
      "Another device is called laptop"
    )
    expect(env.call).not.toHaveBeenCalledWith(
      "rename_host_device",
      expect.anything()
    )

    await userEvent.clear(input)
    await userEvent.type(input, " Study {Enter}")
    expect(env.call).toHaveBeenCalledWith("rename_host_device", {
      id: IMAC,
      name: "study",
    })
    expect(await row(IMAC).findByText("study")).toBeInTheDocument()
    expect(row(IMAC).queryByRole("textbox")).toBeNull()
  })

  it("removes a device that is not connected, once confirmed", async () => {
    server({ devices: BOTH, unnamedHosts: 0 })
    await mount()
    await userEvent.click(
      await screen.findByRole("button", { name: "Devices" })
    )
    await userEvent.click(row(BOOK).getByRole("button", { name: "Remove" }))
    expect(
      row(BOOK).getByText("Remove laptop from the list?")
    ).toBeInTheDocument()
    expect(env.call).not.toHaveBeenCalledWith(
      "forget_host_device",
      expect.anything()
    )
    await userEvent.click(row(BOOK).getByRole("button", { name: "Remove" }))
    expect(env.call).toHaveBeenCalledWith("forget_host_device", { id: BOOK })
    await waitFor(() =>
      expect(document.querySelector(`[data-device="${BOOK}"]`)).toBeNull()
    )
  })

  it("stops a device's lending from here, once confirmed", async () => {
    server({ devices: BOTH, unnamedHosts: 0 })
    await mount(["host_bridge_ws", "host_devices", "stop_host_device"])
    await userEvent.click(
      await screen.findByRole("button", { name: "Devices" })
    )
    // Only a device that is online and lends something can be stopped.
    expect(row(BOOK).queryByRole("button", { name: "Stop lending" })).toBeNull()
    await userEvent.click(
      row(IMAC).getByRole("button", { name: "Stop lending" })
    )
    expect(
      row(IMAC).getByText(/^Stop everything desktop lends\?/)
    ).toBeInTheDocument()
    expect(env.call).not.toHaveBeenCalledWith(
      "stop_host_device",
      expect.anything()
    )
    await userEvent.click(
      row(IMAC).getByRole("button", { name: "Stop lending" })
    )
    expect(env.call).toHaveBeenCalledWith("stop_host_device", { id: IMAC })
    await waitFor(() =>
      expect(
        document.querySelector(`[data-device="${IMAC}"] [data-device-stopped]`)
      ).not.toBeNull()
    )
    expect(row(IMAC).queryByRole("button", { name: "Stop lending" })).toBeNull()
  })

  it("offers no stop where the server cannot", async () => {
    server({ devices: BOTH, unnamedHosts: 0 })
    await mount()
    await userEvent.click(
      await screen.findByRole("button", { name: "Devices" })
    )
    expect(row(IMAC).queryByRole("button", { name: "Stop lending" })).toBeNull()
  })

  it("names the conversations working on a device", async () => {
    server({
      devices: [
        {
          ...BOTH[0],
          inUse: [
            { conversationId: 7, title: "Fix the build" },
            { conversationId: 8, title: "" },
          ],
        },
        BOTH[1],
      ],
      unnamedHosts: 0,
    })
    await mount()
    await userEvent.click(
      await screen.findByRole("button", { name: "Devices" })
    )
    expect(
      row(IMAC).getByText("In use by: Fix the build, Untitled")
    ).toBeInTheDocument()
    expect(
      document.querySelector(`[data-device="${BOOK}"] [data-device-in-use]`)
    ).toBeNull()
  })

  it("shows what the server refused", async () => {
    server({ devices: BOTH, unnamedHosts: 0 })
    await mount()
    await userEvent.click(
      await screen.findByRole("button", { name: "Devices" })
    )
    env.call.mockRejectedValueOnce(new Error("No such device"))
    await userEvent.click(row(BOOK).getByRole("button", { name: "Remove" }))
    await userEvent.click(row(BOOK).getByRole("button", { name: "Remove" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not change it: No such device"
    )
  })
})

describe("naming this computer", () => {
  const unnamed: HostDevice[] = [
    { ...BOTH[0], name: "study-imac", named: false },
    BOTH[1],
  ]

  it("asks once, offering the server's name; skipping keeps it", async () => {
    server({ devices: unnamed, unnamedHosts: 0 })
    await mount()
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Name this computer")).toBeInTheDocument()
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue(
      "study-imac"
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "Skip" }))
    expect(env.call).toHaveBeenCalledWith("rename_host_device", {
      id: IMAC,
      name: "study-imac",
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(trigger()).toBeInTheDocument()
  })

  it("takes the name typed, checked as a rename is", async () => {
    server({ devices: unnamed, unnamedHosts: 0 })
    await mount()
    const dialog = await screen.findByRole("dialog")
    const input = within(dialog).getByRole("textbox", { name: "Name" })
    await userEvent.clear(input)
    await userEvent.type(input, "laptop")
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Use this name" })
    )
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Another device is called laptop"
    )
    await userEvent.clear(input)
    await userEvent.type(input, "Desktop{Enter}")
    expect(env.call).toHaveBeenCalledWith("rename_host_device", {
      id: IMAC,
      name: "desktop",
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("does not ask about a name already chosen, nor in a browser", async () => {
    server({ devices: BOTH, unnamedHosts: 0 })
    await mount()
    await screen.findByRole("button", { name: "Devices" })
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("does not ask in a browser, which has no computer of its own", async () => {
    env.desktop = false
    server({ devices: unnamed, unnamedHosts: 0 })
    await mount()
    await screen.findByRole("button", { name: "Devices" })
    expect(env.shellCall).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
