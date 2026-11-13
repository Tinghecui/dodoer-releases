import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  remote: false,
  openUrl: vi.fn(async () => {}),
  openSettingsWindow: vi.fn(async () => {}),
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => h.remote,
  isRemoteDesktopWindow: () => h.remote,
  openUrl: h.openUrl,
}))
vi.mock("@/lib/transport", () => ({
  getServerBaseUrl: () => "https://james.example.com",
  getTransport: () => ({ call: vi.fn() }),
}))
vi.mock("@/lib/transport/web-connection-store", () => ({
  getWebConnectionSnapshot: () => "connected",
  subscribeWebConnection: () => () => {},
}))
vi.mock("@/lib/api", () => ({ openSettingsWindow: h.openSettingsWindow }))

import { resetCoworkInfoForTests, type CoworkInfo } from "./info"
import {
  COWORK_AI_ACCOUNTS_URL,
  isSignInFailureText,
  openAgentSignIn,
  signInViaPortal,
} from "./sign-in"

const PORTAL: CoworkInfo = {
  product: "Cowork",
  projectsRoot: null,
  portal: true,
  updateDisabled: false,
}

beforeEach(() => {
  h.remote = false
  h.openUrl.mockClear()
  h.openSettingsWindow.mockClear()
  resetCoworkInfoForTests()
})

afterEach(() => {
  resetCoworkInfoForTests()
})

describe("signInViaPortal", () => {
  it("is the portal's job only behind it, and only for the agents it manages", () => {
    for (const agent of ["claude_code", "codex", "grok"] as const) {
      expect(signInViaPortal(agent, PORTAL)).toBe(true)
    }
    expect(signInViaPortal("gemini", PORTAL)).toBe(false)
    expect(signInViaPortal("claude_code", { ...PORTAL, portal: false })).toBe(
      false
    )
    expect(signInViaPortal("claude_code", null)).toBe(false)
    expect(signInViaPortal(null, PORTAL)).toBe(false)
  })

  it("reads the cached Cowork info by default (unknown = not portal)", () => {
    expect(signInViaPortal("claude_code")).toBe(false)
    resetCoworkInfoForTests(PORTAL)
    expect(signInViaPortal("claude_code")).toBe(true)
  })
})

describe("openAgentSignIn", () => {
  it("opens the portal's AI accounts in a new tab behind the portal", () => {
    resetCoworkInfoForTests(PORTAL)
    openAgentSignIn("claude_code")
    expect(COWORK_AI_ACCOUNTS_URL).toBe("/_cowork/account#ai-accounts")
    expect(h.openUrl).toHaveBeenCalledWith("/_cowork/account#ai-accounts")
    expect(h.openSettingsWindow).not.toHaveBeenCalled()
  })

  it("opens it on the workspace's domain from a remote desktop window", () => {
    resetCoworkInfoForTests(PORTAL)
    h.remote = true
    openAgentSignIn("codex")
    expect(h.openUrl).toHaveBeenCalledWith(
      "https://james.example.com/_cowork/account#ai-accounts"
    )
  })

  it("keeps the agent's settings page without the portal, or for other agents", () => {
    openAgentSignIn("claude_code")
    expect(h.openSettingsWindow).toHaveBeenLastCalledWith("agents", {
      agentType: "claude_code",
    })
    resetCoworkInfoForTests(PORTAL)
    openAgentSignIn("gemini")
    expect(h.openSettingsWindow).toHaveBeenLastCalledWith("agents", {
      agentType: "gemini",
    })
    expect(h.openUrl).not.toHaveBeenCalled()
  })
})

describe("isSignInFailureText", () => {
  it("recognizes the CLI's not-signed-in records", () => {
    expect(isSignInFailureText("Not logged in · Please run /login")).toBe(true)
    expect(isSignInFailureText("Invalid API key · Please run /login")).toBe(
      true
    )
    expect(
      isSignInFailureText(
        "Login expired · Run /login to sign in again, or re-authenticate your Anthropic profile"
      )
    ).toBe(true)
  })

  it("leaves other failures, and usage-limit banners, alone", () => {
    expect(isSignInFailureText("API Error: 503 overloaded")).toBe(false)
    expect(isSignInFailureText("stream disconnected before completion")).toBe(
      false
    )
    expect(
      isSignInFailureText(
        "You've hit your limit · resets 3pm · /upgrade or run /login to switch accounts"
      )
    ).toBe(false)
    expect(isSignInFailureText("")).toBe(false)
  })
})
