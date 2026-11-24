import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("@/lib/platform", () => ({ isDesktop: () => false }))
const store = vi.hoisted(() => ({ resumeWebAfterLogin: vi.fn() }))
vi.mock("@/lib/transport/web-connection-store", () => ({
  resumeWebAfterLogin: store.resumeWebAfterLogin,
}))

import LoginPage from "./page"
import enMessages from "@/i18n/messages/en.json"

const reply = (status: number, challenge?: string) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(challenge ? { "WWW-Authenticate": challenge } : {}),
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  router.replace.mockClear()
  store.resumeWebAfterLogin.mockClear()
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  window.history.replaceState(null, "", "/")
})

function submit(token: string) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <LoginPage />
    </NextIntlClientProvider>
  )
  fireEvent.change(screen.getByPlaceholderText("Access Token"), {
    target: { value: token },
  })
  fireEvent.click(screen.getByRole("button", { name: "Connect" }))
}

describe("login page", () => {
  it("asks a proxy for a 401 instead of a redirect", async () => {
    // The page first asks whether a proxy signed the browser in (no token);
    // this server wants one. The form's request follows.
    fetchMock
      .mockResolvedValueOnce(reply(401, 'Bearer realm="codeg"'))
      .mockResolvedValue(reply(200))
    submit("tok")
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalled())
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      Authorization: "Bearer tok",
      "X-Requested-With": "XMLHttpRequest",
    })
  })

  // #1440：之前被拒过的连接停在「会话已过期」，进工作区之前要用新令牌重连。
  it("resumes the rejected connection before entering the workspace", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(401, 'Bearer realm="codeg"'))
      .mockResolvedValue(reply(200))
    submit("tok")
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace")
    )
    expect(store.resumeWebAfterLogin).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("codeg_token")).toBe("tok")
  })

  it("does not resume the connection for a rejected token", async () => {
    fetchMock.mockResolvedValue(reply(401, 'Bearer realm="codeg"'))
    submit("bad")
    await screen.findByText("Invalid token. Please check and try again.")
    expect(store.resumeWebAfterLogin).not.toHaveBeenCalled()
  })

  it("calls the token invalid when Codeg rejects it", async () => {
    fetchMock.mockResolvedValue(reply(401, 'Bearer realm="codeg"'))
    submit("bad")
    expect(
      await screen.findByText("Invalid token. Please check and try again.")
    ).toBeInTheDocument()
  })

  it("does not blame the token when a proxy in front of Codeg refused", async () => {
    fetchMock.mockResolvedValue(
      reply(401, 'Cloudflare-Access resource_metadata="https://x.test/m"')
    )
    submit("tok")
    expect(
      await screen.findByText(/Your sign-in to the proxy/)
    ).toBeInTheDocument()
    expect(
      screen.queryByText("Invalid token. Please check and try again.")
    ).not.toBeInTheDocument()
  })
})

describe("login page behind a proxy", () => {
  it("goes straight to the workspace when the proxy already admits the browser", async () => {
    fetchMock.mockResolvedValue(reply(200))
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <LoginPage />
      </NextIntlClientProvider>
    )
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace")
    )
    expect(localStorage.getItem("codeg_proxy_auth")).toBe("1")
    expect(store.resumeWebAfterLogin).toHaveBeenCalledTimes(1)
  })
})

// #74: `/login?token=<value>` signs in, and the value leaves the address bar
// (and the history entry) the moment the page reads it.
describe("login page opened from a sign-in link", () => {
  function openLink(url: string) {
    window.history.replaceState(null, "", url)
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <LoginPage />
      </NextIntlClientProvider>
    )
  }

  it("signs in with a good token and takes it out of the address", async () => {
    fetchMock.mockResolvedValue(reply(200))
    openLink("/login?token=good")
    // Synchronously on mount, before any answer from the server.
    expect(window.location.search).toBe("?token")
    expect(window.location.href).not.toContain("good")

    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace")
    )
    expect(localStorage.getItem("codeg_token")).toBe("good")
    expect(store.resumeWebAfterLogin).toHaveBeenCalledTimes(1)
    // Straight to the token check: no proxy probe without credentials first.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/health")
    expect(init.headers).toMatchObject({ Authorization: "Bearer good" })
  })

  it("says why a bad token was rejected and leaves the form usable", async () => {
    fetchMock.mockResolvedValue(reply(401, 'Bearer realm="codeg"'))
    openLink("/login?token=bad-token-xyz")
    expect(window.location.href).not.toContain("bad-token-xyz")

    expect(
      await screen.findByText("Invalid token. Please check and try again.")
    ).toBeInTheDocument()
    expect(router.replace).not.toHaveBeenCalled()
    expect(localStorage.getItem("codeg_token")).toBeNull()
    const input = screen.getByPlaceholderText("Access Token")
    expect(input).toHaveValue("bad-token-xyz")
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled()

    // Fixing the token in the form still works.
    fetchMock.mockResolvedValue(reply(200))
    fireEvent.change(input, { target: { value: "good" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace")
    )
    expect(localStorage.getItem("codeg_token")).toBe("good")
  })

  it("reports an unreachable server instead of blaming the token", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    openLink("/login?token=good")
    expect(
      await screen.findByText("Unable to connect to the server")
    ).toBeInTheDocument()
  })

  it("keeps the other parts of the address", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    openLink("/login?lang=de&token=good#x")
    expect(window.location.search).toBe("?lang=de&token=")
    expect(window.location.hash).toBe("#x")
  })

  it("changes nothing for a bare ?token (just the form)", async () => {
    fetchMock.mockResolvedValue(reply(401, 'Bearer realm="codeg"'))
    openLink("/login?token")
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    // Only the credential-less proxy probe; nothing was submitted.
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty(
      "Authorization"
    )
    expect(window.location.search).toBe("?token")
    expect(screen.getByPlaceholderText("Access Token")).toHaveValue("")
    expect(router.replace).not.toHaveBeenCalled()
  })
})
