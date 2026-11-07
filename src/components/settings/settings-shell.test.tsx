import { describe, expect, it } from "vitest"

import { settingsTargetFor } from "@/lib/settings-scope"

import { settingsNavItemsFor } from "./settings-shell"

describe("settingsNavItemsFor", () => {
  it("drops the Web service page in a browser session and nothing else", () => {
    const labels = settingsNavItemsFor("web").map((item) => item.labelKey)
    // There is no second server to configure from inside the one you are
    // already talking to.
    expect(labels).not.toContain("web_service")
    // The Browser page is mostly a desktop browser engine, but site rules,
    // what a server starting in a terminal does and the terminal's link menu
    // all still decide something here — and this page is the only place they
    // can be set, so the entry has to lead there.
    expect(labels).toContain("browser")
    expect(labels).toEqual(
      settingsNavItemsFor("tauri")
        .map((item) => item.labelKey)
        .filter((label) => label !== "web_service")
    )
  })

  it("files this computer's app pages first, then the daemon's", () => {
    const items = settingsNavItemsFor("tauri")
    const scopes = items.map((item) => item.scope)
    // Two runs, app then server: the nav renders one heading per run.
    expect(scopes).toEqual([...scopes].sort())
    const of = (scope: "app" | "server") =>
      items.filter((item) => item.scope === scope).map((item) => item.labelKey)
    expect(of("app")).toEqual([
      "appearance",
      "general",
      "shortcuts",
      "browser",
      "computer_use",
      "system",
    ])
    // What an agent on the daemon reads: changing these on a remote window
    // changes them for that server.
    expect(of("server")).toEqual(
      expect.arrayContaining([
        "agents",
        "model_providers",
        "mcp",
        "skills",
        "skill_packs",
        "collaboration",
        "chat_channels",
        "web_service",
      ])
    )
  })

  it("shows only the app's pages in the client-only local window", () => {
    const labels = settingsNavItemsFor(
      "tauri",
      settingsTargetFor("tauri", { mode: "client" }, null)
    ).map((item) => item.labelKey)
    expect(labels).toEqual([
      "appearance",
      "general",
      "shortcuts",
      "browser",
      "computer_use",
      "system",
    ])
    // A client-only window bound to a server edits that server's pages.
    const remote = settingsNavItemsFor(
      "tauri",
      settingsTargetFor(
        "tauri",
        { mode: "client" },
        {
          name: "Cowork",
          base_url: "https://ws.example",
        }
      )
    )
    expect(remote.map((item) => item.labelKey)).toContain("agents")
  })

  it("keeps every page on the desktop", () => {
    const labels = settingsNavItemsFor("tauri").map((item) => item.labelKey)
    expect(labels).toContain("web_service")
    expect(labels).toContain("browser")
  })
})
