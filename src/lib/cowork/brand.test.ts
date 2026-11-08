import type { AbstractIntlMessages } from "next-intl"
import { describe, expect, it } from "vitest"

import en from "@/i18n/messages/en.json"
import {
  brandMessages,
  brandText,
  brandTitle,
  PRODUCT_NAME,
  resolveProductName,
} from "./brand"

describe("brand overlay", () => {
  it("defaults the product name to Cowork", () => {
    expect(resolveProductName(undefined)).toBe("Cowork")
    expect(resolveProductName(" ")).toBe("Cowork")
    expect(resolveProductName("Acme")).toBe("Acme")
  })

  it("runs the suite with the source name (vitest.config.ts)", () => {
    expect(PRODUCT_NAME).toBe("dodoer")
  })

  it("replaces the capitalised word only", () => {
    expect(brandText("Codeg's chat in Codeg", "Cowork")).toBe(
      "Cowork's chat in Cowork"
    )
    expect(brandText("run codeg-mcp from ~/.codeg", "Cowork")).toBe(
      "run codeg-mcp from ~/.codeg"
    )
    expect(brandText("Codegen stays", "Cowork")).toBe("Codegen stays")
  })

  it("replaces the fork's own name, not identifiers built from it", () => {
    const cases: Array<[string, string]> = [
      ["Exit dodoer", "Exit Cowork"],
      ["dodoer's window", "Cowork's window"],
      ["dodoer’s server", "Cowork’s server"],
      ["Login - dodoer", "Login - Cowork"],
      ["Dodoer needs Pi 0.81.0", "Cowork needs Pi 0.81.0"],
      ["see dodoer. Then", "see Cowork. Then"],
      ["the dodoer-managed key", "the dodoer-managed key"],
      ["dodoer_token stays", "dodoer_token stays"],
      ["run `dodoer serve` now", "run `dodoer serve` now"],
      ["/Applications/dodoer.app", "/Applications/dodoer.app"],
    ]
    for (const [input, expected] of cases) {
      expect(brandText(input, "Cowork")).toBe(expected)
    }
  })

  it("replaces lower-case codeg in prose, not in paths, binaries or code", () => {
    const cases: Array<[string, string]> = [
      ["Applies to every codeg window.", "Applies to every Cowork window."],
      ["codeg writes them into ~/.cursor", "Cowork writes them into ~/.cursor"],
      ["back through codeg. codeg adds", "back through Cowork. Cowork adds"],
      ["codeg's server", "Cowork's server"],
      ["Login - codeg", "Login - Cowork"],
      ["Chrome，codeg 管不到", "Chrome，Cowork 管不到"],
      ["run codeg-mcp from ~/.codeg", "run codeg-mcp from ~/.codeg"],
      ["open codeg.db or CODEG_TOKEN", "open codeg.db or CODEG_TOKEN"],
      ["[providers.codeg]\ntype", "[providers.codeg]\ntype"],
      ['model_provider = "codeg"', 'model_provider = "codeg"'],
      ["run `codeg serve --x` now", "run `codeg serve --x` now"],
      ["the codeg_token key", "the codeg_token key"],
      ["see https://x.dev/codeg", "see https://x.dev/codeg"],
      ["codegen", "codegen"],
    ]
    for (const [input, expected] of cases) {
      expect(brandText(input, "Cowork")).toBe(expected)
    }
  })

  it("leaves no prose codeg in the English catalog", () => {
    const strings: string[] = []
    const walk = (node: unknown) => {
      if (typeof node === "string") strings.push(node)
      else if (node && typeof node === "object")
        Object.values(node).forEach(walk)
    }
    walk(brandMessages(en, "Cowork"))
    // "codeg" / "dodoer" as a standalone word between spaces / sentence
    // punctuation, outside inline code: the product name, which must read
    // Cowork.
    const prose = /(^|[\s(“"'，。])(codeg|dodoer)($|[\s,;!?)’'”，。]|\.(\s|$))/
    const leftovers = strings
      .map((s) => s.replace(/`[^`]*`/g, ""))
      .filter((s) => prose.test(s))
    expect(leftovers).toEqual([])
    expect(brandMessages(en, "Cowork").LoginPage.documentTitle).toMatch(
      /Cowork$/
    )
  })

  it("is a no-op when the name is the source one", () => {
    const messages = { a: "dodoer" }
    expect(brandMessages(messages, "dodoer")).toBe(messages)
  })

  it("rewrites a whole catalog without mutating it", () => {
    const branded = brandMessages(en, "Cowork")
    expect(branded.LoginPage.brand).toBe("Cowork")
    expect(en.LoginPage.brand).toBe("dodoer")
    expect(JSON.stringify(branded)).not.toMatch(/\bCodeg\b/)
    expect(JSON.stringify(branded)).not.toMatch(/(?<![-\w])[Dd]odoer(?![-\w])/)
  })

  // The app's catalogs are precompiled by next-intl (`precompile: true`):
  // messages with arguments, plurals or tags are icu-minify arrays, which
  // `AbstractIntlMessages` does not describe.
  it("keeps precompiled messages as arrays and only rewrites their text", () => {
    const branded = brandMessages(
      {
        plain: "Open dodoer",
        arg: ["Starts in ", ["branch"], " in dodoer"],
        tag: ["Open ", ["dodoer"], " in ", ["highlight", "Codeg"]],
        plural: [
          ["count", 2, { one: [0, " dodoer window"], other: [0, " windows"] }],
        ],
        select: [["kind", 1, { app: "the dodoer app", other: ["x"] }]],
        number: [["n", 4, "percent"], " of Codeg"],
      } as unknown as AbstractIntlMessages,
      "Cowork"
    )
    expect(branded).toEqual({
      plain: "Open Cowork",
      arg: ["Starts in ", ["branch"], " in Cowork"],
      tag: ["Open ", ["dodoer"], " in ", ["highlight", "Cowork"]],
      plural: [
        ["count", 2, { one: [0, " Cowork window"], other: [0, " windows"] }],
      ],
      select: [["kind", 1, { app: "the Cowork app", other: ["x"] }]],
      number: [["n", 4, "percent"], " of Cowork"],
    })
    expect(Array.isArray(branded.arg)).toBe(true)
  })

  it("builds document titles", () => {
    expect(brandTitle("Settings")).toBe(`Settings - ${PRODUCT_NAME}`)
    expect(brandTitle(null)).toBe(PRODUCT_NAME)
  })
})
