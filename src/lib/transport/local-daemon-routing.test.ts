// Reads the Rust sources: the commands the app registers (`generate_handler!`
// in `lib.rs`) and the routes `codeg-server` serves (`.route("/name", …)`).
// A command the server does not serve can only be answered by the app, so it
// must be in SHELL_ONLY_COMMANDS; anything routed to the app although the
// server has it, or to both, must exist on both sides.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  BOTH_COMMANDS,
  SHELL_COMMANDS,
  SHELL_ONLY_COMMANDS,
  localDaemonRoute,
} from "./local-daemon-routing"

const SRC = join(__dirname, "../../../src-tauri/src")

function rustFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return rustFiles(path)
    return path.endsWith(".rs") ? [path] : []
  })
}

function invokeCommands(): Set<string> {
  const lib = readFileSync(join(SRC, "lib.rs"), "utf8")
  const start = lib.indexOf("generate_handler![")
  const end = lib.indexOf("])", start)
  expect(start).toBeGreaterThan(-1)
  const body = lib
    .slice(start + "generate_handler![".length, end)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/#\[[^\]]*\]/g, "")
  return new Set(
    body
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.split("::").pop() as string)
  )
}

function serverRoutes(): Set<string> {
  const routes = new Set<string>()
  for (const file of rustFiles(SRC)) {
    const source = readFileSync(file, "utf8")
    for (const m of source.matchAll(/\.route\(\s*"\/([A-Za-z0-9_]+)"/g)) {
      routes.add(m[1])
    }
  }
  return routes
}

describe("local daemon routing agrees with the Rust sources", () => {
  const invoke = invokeCommands()
  const routes = serverRoutes()

  it("reads both sides", () => {
    expect(invoke.size).toBeGreaterThan(300)
    expect(routes.size).toBeGreaterThan(300)
    expect(invoke.has("list_conversations")).toBe(true)
    expect(routes.has("list_conversations")).toBe(true)
  })

  it("sends every app-only command to the app, and nothing else as app-only", () => {
    const appOnly = [...invoke].filter((c) => !routes.has(c)).sort()
    expect([...SHELL_ONLY_COMMANDS].sort()).toEqual(appOnly)
  })

  it("names only commands both sides have in SHELL_COMMANDS and BOTH_COMMANDS", () => {
    for (const command of [...SHELL_COMMANDS, ...BOTH_COMMANDS]) {
      expect(invoke.has(command), `${command} in the app`).toBe(true)
      expect(routes.has(command), `${command} on the server`).toBe(true)
    }
  })
})

describe("localDaemonRoute", () => {
  it("routes by the tables", () => {
    expect(localDaemonRoute("list_conversations")).toBe("daemon")
    expect(localDaemonRoute("acp_prompt")).toBe("daemon")
    expect(localDaemonRoute("remote_http_call")).toBe("shell")
    expect(localDaemonRoute("browser_open_tab")).toBe("shell")
    expect(localDaemonRoute("open_settings_window")).toBe("shell")
    expect(localDaemonRoute("computer_share_window")).toBe("shell")
    expect(localDaemonRoute("set_log_settings")).toBe("both")
    expect(localDaemonRoute("a_command_nobody_has")).toBe("daemon")
  })
})
