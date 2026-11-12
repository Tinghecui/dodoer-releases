import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CLIENT_API_VERSION,
  compareVersions,
  judgeCompat,
  readServerCompat,
  serverHasFeature,
} from "./compat"

describe("readServerCompat", () => {
  it("reads the contract fields", () => {
    const server = readServerCompat({
      status: "ok",
      version: "0.40.0",
      api_version: 1,
      min_desktop_version: "1.2.0",
      features: ["cowork_info", 3],
    })
    expect(server).toEqual({
      apiVersion: 1,
      minDesktopVersion: "1.2.0",
      features: ["cowork_info"],
    })
    expect(serverHasFeature(server, "cowork_info")).toBe(true)
    expect(serverHasFeature(server, "nope")).toBe(false)
  })

  it("reads a server from before the contract as version 0, no minimum", () => {
    expect(readServerCompat({ status: "ok", version: "0.40.0" })).toEqual({
      apiVersion: 0,
      minDesktopVersion: null,
      features: [],
    })
    expect(readServerCompat(null).apiVersion).toBe(0)
    expect(
      readServerCompat({ api_version: "2", min_desktop_version: "soon" })
    ).toEqual({ apiVersion: 0, minDesktopVersion: null, features: [] })
  })
})

describe("judgeCompat", () => {
  const server = { apiVersion: 2, minDesktopVersion: "1.2.0", features: [] }

  it("is fine when both sides are new enough", () => {
    expect(judgeCompat(server, "1.2.0")).toEqual({ kind: "ok" })
    expect(judgeCompat(server, "1.3.1", 1)).toEqual({ kind: "ok" })
  })

  it("asks to update an app older than the server's minimum", () => {
    expect(judgeCompat(server, "1.1.0")).toEqual({
      kind: "desktop_too_old",
      version: "1.1.0",
      required: "1.2.0",
    })
  })

  it("blames the server first when it is too old for this client", () => {
    const old = { apiVersion: 0, minDesktopVersion: "9.0.0", features: [] }
    expect(judgeCompat(old, "1.2.0", 1)).toEqual({
      kind: "server_too_old",
      apiVersion: 0,
      required: 1,
    })
  })

  it("accepts a server from before the contract when asked for nothing", () => {
    expect(
      judgeCompat(
        { apiVersion: 0, minDesktopVersion: null, features: [] },
        "1.1.0",
        0
      )
    ).toEqual({ kind: "ok" })
  })

  it("needs a server on the 0.43 base by default", () => {
    const server = (apiVersion: number) => ({
      apiVersion,
      minDesktopVersion: null,
      features: [],
    })
    expect(judgeCompat(server(1), "1.5.0")).toEqual({
      kind: "server_too_old",
      apiVersion: 1,
      required: 2,
    })
    expect(judgeCompat(server(2), "1.5.0")).toEqual({ kind: "ok" })
  })
})

describe("compareVersions", () => {
  it("compares numerically, ignoring a v prefix and suffixes", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0)
    expect(compareVersions("v1.2.0", "1.2.0")).toBe(0)
    expect(compareVersions("1.2.0-jenny.1", "1.2.1")).toBeLessThan(0)
    expect(compareVersions("garbage", "1.2.0")).toBe(0)
  })
})

describe("CLIENT_API_VERSION", () => {
  it("is the server's API_VERSION of the same build (sent in the WS hello)", () => {
    const rust = readFileSync(
      join(__dirname, "../../../src-tauri/src/compat.rs"),
      "utf8"
    )
    const m = /pub const API_VERSION: u32 = (\d+);/.exec(rust)
    expect(m).not.toBeNull()
    expect(CLIENT_API_VERSION).toBe(Number(m![1]))
  })
})
