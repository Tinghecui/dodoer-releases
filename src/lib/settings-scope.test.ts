import { describe, expect, it } from "vitest"

import { hasServerSettings, settingsTargetFor } from "./settings-scope"

const remote = { name: "Cowork", base_url: "https://ws.example" }

describe("settingsTargetFor", () => {
  it("names the server a remote window is bound to, whatever the app is", () => {
    for (const mode of ["child", "embedded", "client"] as const) {
      expect(settingsTargetFor("tauri", { mode }, remote)).toEqual({
        kind: "remote",
        serverName: "Cowork",
        serverUrl: "https://ws.example",
      })
    }
  })

  it("tells the local daemon setups apart", () => {
    expect(settingsTargetFor("tauri", { mode: "child" }, null).kind).toBe(
      "child"
    )
    expect(settingsTargetFor("tauri", { mode: "client" }, null).kind).toBe(
      "client"
    )
    expect(settingsTargetFor("tauri", { mode: "embedded" }, null).kind).toBe(
      "embedded"
    )
    // An app from before the split announces nothing: it is embedded.
    expect(settingsTargetFor("tauri", null, null).kind).toBe("embedded")
  })

  it("is the page's own server in a browser", () => {
    expect(settingsTargetFor("web", null, null).kind).toBe("web")
  })
})

describe("hasServerSettings", () => {
  it("is false only for the app's own window without a local daemon", () => {
    expect(
      hasServerSettings(settingsTargetFor("tauri", { mode: "client" }, null))
    ).toBe(false)
    expect(
      hasServerSettings(settingsTargetFor("tauri", { mode: "client" }, remote))
    ).toBe(true)
    expect(hasServerSettings(settingsTargetFor("web", null, null))).toBe(true)
  })
})
