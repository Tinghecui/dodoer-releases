import type { AbstractIntlMessages } from "next-intl"
import { describe, expect, it } from "vitest"

import { afterEach, beforeAll, vi } from "vitest"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"

import ar from "@/i18n/messages/ar.json"
import de from "@/i18n/messages/de.json"
import en from "@/i18n/messages/en.json"
import es from "@/i18n/messages/es.json"
import fr from "@/i18n/messages/fr.json"
import ja from "@/i18n/messages/ja.json"
import ko from "@/i18n/messages/ko.json"
import pt from "@/i18n/messages/pt.json"
import zhCN from "@/i18n/messages/zh-CN.json"
import zhTW from "@/i18n/messages/zh-TW.json"
import {
  brandMessages,
  brandText,
  brandTitle,
  COMMENT_FOOTER_NAME,
  COWORK_BUILD,
  isCoworkBuild,
  PRODUCT_NAME,
  SYSTEM_NAME_KEYS,
} from "./brand"

// 换了 NEXT_PUBLIC_PRODUCT_NAME 以后重新加载 brand.ts，看两种构建下导出的值。
async function loadBrandWith(configured: string | undefined) {
  const saved = process.env.NEXT_PUBLIC_PRODUCT_NAME
  if (configured === undefined) delete process.env.NEXT_PUBLIC_PRODUCT_NAME
  else process.env.NEXT_PUBLIC_PRODUCT_NAME = configured
  try {
    vi.resetModules()
    return await import("./brand")
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_PRODUCT_NAME
    else process.env.NEXT_PUBLIC_PRODUCT_NAME = saved
  }
}

describe("display name and build flavour", () => {
  afterEach(() => {
    vi.resetModules()
  })

  it("shows CoTeam in the server web build (variable unset)", async () => {
    const brand = await loadBrandWith(undefined)
    expect(brand.PRODUCT_NAME).toBe("CoTeam")
    expect(brand.COWORK_BUILD).toBe(true)
  })

  it("shows CoTeam in the desktop build (=dodoer), still not a Cowork build", async () => {
    const brand = await loadBrandWith("dodoer")
    expect(brand.PRODUCT_NAME).toBe("CoTeam")
    expect(brand.COWORK_BUILD).toBe(false)
  })

  it("tells the builds apart exactly as before", () => {
    // 原来是 (configured?.trim() || "Cowork") !== "dodoer"
    expect(isCoworkBuild(undefined)).toBe(true)
    expect(isCoworkBuild("")).toBe(true)
    expect(isCoworkBuild(" ")).toBe(true)
    expect(isCoworkBuild("Cowork")).toBe(true)
    expect(isCoworkBuild("Acme")).toBe(true)
    expect(isCoworkBuild("dodoer")).toBe(false)
    expect(isCoworkBuild(" dodoer ")).toBe(false)
  })

  it("runs the suite as the desktop build (vitest.config.ts)", () => {
    expect(PRODUCT_NAME).toBe("CoTeam")
    expect(COWORK_BUILD).toBe(false)
  })
})

describe("brand overlay", () => {
  it("is on in the desktop build too", () => {
    expect(brandText("Exit dodoer")).toBe("Exit CoTeam")
    expect(brandMessages({ a: "Open dodoer" })).toEqual({ a: "Open CoTeam" })
  })

  // 德语的所有格直接在名字后面加 s（"dodoers Fenster"）：也是产品名。
  it("replaces the German genitive (dodoers, codegs) too", () => {
    for (const [input, expected] of [
      ["oder dodoers eigenen Terminals.", "oder CoTeams eigenen Terminals."],
      ["Shortcuts. dodoers Fenster", "Shortcuts. CoTeams Fenster"],
      [
        "auf codegs `[model_providers.codeg]`",
        "auf CoTeams `[model_providers.codeg]`",
      ],
      ["Codegs Server", "CoTeams Server"],
      ["Coworks Portal", "CoTeams Portal"],
      ["the dodoers-x key", "the dodoers-x key"],
      ["see /opt/dodoers/bin", "see /opt/dodoers/bin"],
      ["dodoerstuff", "dodoerstuff"],
    ] as const) {
      expect(brandText(input)).toBe(expected)
    }
  })

  it("replaces the whole word Cowork, not identifiers or paths built from it", () => {
    const cases: Array<[string, string]> = [
      ["through the Cowork server", "through the CoTeam server"],
      ["Cowork's portal", "CoTeam's portal"],
      ["经 Cowork 服务器", "经 CoTeam 服务器"],
      ["upgrade Cowork.", "upgrade CoTeam."],
      ["the Cowork-sso cookie", "the Cowork-sso cookie"],
      ["Cowork_TOKEN stays", "Cowork_TOKEN stays"],
      ["see /opt/Cowork/bin", "see /opt/Cowork/bin"],
      ["open Cowork.app", "open Cowork.app"],
      ["run `Cowork serve` now", "run `Cowork serve` now"],
      ["CoworkTextKey", "CoworkTextKey"],
      ["the cowork command", "the cowork command"],
      ["COWORK_URL", "COWORK_URL"],
    ]
    for (const [input, expected] of cases) {
      expect(brandText(input, "CoTeam")).toBe(expected)
    }
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

  it("leaves Codeg in commands and paths alone", () => {
    const cases: Array<[string, string]> = [
      ["run `Codeg serve` now", "run `Codeg serve` now"],
      ["see /opt/Codeg/bin", "see /opt/Codeg/bin"],
      ["the Codeg-sso cookie", "the Codeg-sso cookie"],
      ["Codeg_TOKEN stays", "Codeg_TOKEN stays"],
      ["open Codeg.app", "open Codeg.app"],
      ["C:\\Codeg\\bin", "C:\\Codeg\\bin"],
      ["upgrade Codeg.", "upgrade CoTeam."],
      ["Codeg's window, in `Codeg` too", "CoTeam's window, in `Codeg` too"],
    ]
    for (const [input, expected] of cases) {
      expect(brandText(input, "CoTeam")).toBe(expected)
    }
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
      // 指着系统里 app 名字的 "(dodoer)" 是有意留的（SYSTEM_NAME_KEYS）
      .map((s) =>
        s
          .replace(/`[^`]*`/g, "")
          .split(" (dodoer)")
          .join("")
      )
      .filter((s) => prose.test(s))
    expect(leftovers).toEqual([])
    expect(brandMessages(en, "Cowork").LoginPage.documentTitle).toMatch(
      /Cowork$/
    )
  })

  // 十种语言：加载后当产品名用的旧名字一个不剩（包括德语的所有格
  // "dodoers"），路径、命令、配置键原样留着。
  for (const [locale, catalog] of [
    ["en", en],
    ["zh-CN", zhCN],
    ["zh-TW", zhTW],
    ["ja", ja],
    ["ko", ko],
    ["es", es],
    ["de", de],
    ["fr", fr],
    ["pt", pt],
    ["ar", ar],
  ] as const) {
    it(`leaves no old product name in the ${locale} catalog`, () => {
      const branded = brandMessages(catalog as AbstractIntlMessages)
      const strings: string[] = []
      const walk = (node: unknown) => {
        if (typeof node === "string") strings.push(node)
        else if (node && typeof node === "object")
          Object.values(node).forEach(walk)
      }
      walk(branded)
      // 允许的两种：指着系统里 app 名字的 "(dodoer)"、评论署名原文里后端的名字
      const prose = strings.map((s) =>
        s
          .replace(/`[^`]*`/g, "")
          .split("CoTeam (dodoer)")
          .join("CoTeam")
          .replace(`Generated with ${COMMENT_FOOTER_NAME}`, "")
      )
      const word =
        /(?<![-\w./~$@:\\"])(dodoer|Dodoer|Codeg|codeg|Cowork)s?(?![-\w/~:\\"]|\.\w)/
      expect(prose.filter((s) => word.test(s))).toEqual([])
      expect(JSON.stringify(branded)).toContain("CoTeam")
      // 标识符和路径没被碰到
      const before = JSON.stringify(catalog)
      const after = JSON.stringify(branded)
      for (const kept of ["~/.codeg", "codeg-mcp", "dodoer-managed"]) {
        expect(after.split(kept).length).toBe(before.split(kept).length)
      }
    })
  }

  // 桌面包在 macOS 系统设置、应用程序文件夹里还叫 dodoer：教用户去那里找的句子
  // 要带上系统里的名字，不然用户找不到。
  it("keeps the system's app name where it sends people to System Settings", () => {
    const b = brandMessages(en as AbstractIntlMessages) as unknown as typeof en
    expect(b.ChromeSettings.problemFileDenied).toContain(
      "let CoTeam (dodoer) read “Google Chrome” in System Settings"
    )
    expect(b.ComputerUse.codegGranted).toContain(
      "turn it off for CoTeam (dodoer) in System Settings"
    )
    expect(b.ComputerUse.permissions.why).toContain("not CoTeam (dodoer)")
    expect(b.DesktopNotificationSettings.identityDegradedHint).toContain(
      "Installing CoTeam (dodoer) to your Applications folder"
    )
    const zh = brandMessages(
      zhCN as AbstractIntlMessages
    ) as unknown as typeof zhCN
    expect(zh.ComputerUse.codegGranted).toContain("CoTeam (dodoer)")
    // 别的句子不带括号
    expect(b.LoginPage.brand).toBe("CoTeam")
  })

  // 设置页引用的评论署名必须和后端真发出去的一样：cowork.rs 的 PRODUCT_NAME
  // 指向 brand.rs 的 DISPLAY_NAME，字面量在 brand.rs 里。
  it("quotes the comment footer the backend actually posts", () => {
    const src = resolve(__dirname, "../../../src-tauri/src")
    const cowork = readFileSync(resolve(src, "cowork.rs"), "utf8")
    expect(cowork).toMatch(
      /pub const PRODUCT_NAME: &str = crate::brand::DISPLAY_NAME;/
    )
    const brandRs = readFileSync(resolve(src, "brand.rs"), "utf8")
    const backend = /pub const DISPLAY_NAME: &str = "([^"]+)";/.exec(
      brandRs
    )?.[1]
    expect(backend).toBe("CoTeam")
    expect(COMMENT_FOOTER_NAME).toBe(backend)
    for (const catalog of [en, zhCN]) {
      const b = brandMessages(
        catalog as AbstractIntlMessages
      ) as unknown as typeof en
      expect(b.Forge.settingsCommentFooterHint).toContain(
        `🤖 Generated with ${backend}`
      )
    }
  })

  it("rewrites a whole catalog without mutating it", () => {
    const branded = brandMessages(en, "Cowork")
    expect(branded.LoginPage.brand).toBe("Cowork")
    expect(en.LoginPage.brand).toBe("dodoer")
    expect(JSON.stringify(branded)).not.toMatch(/\bCodeg\b/)
    expect(JSON.stringify(branded).split(" (dodoer)").join("")).not.toMatch(
      /(?<![-\w])[Dd]odoer(?![-\w])/
    )
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

  // 应用实际加载的是 next-intl 预编译过的目录（带参数的消息是数组）。
  // 用同一个编译器（icu-minify，next-intl 的依赖）把真目录编一遍再换名，
  // 系统里的名字「CoTeam (dodoer)」和评论署名原文在这种结构下也要保住，
  // 而且整本目录换出来的结果要和「先换名再编译」一模一样。
  describe("on the precompiled catalogs the app loads", () => {
    type Compile = (message: string) => unknown
    let compile: Compile
    const compileTree = (node: unknown): unknown =>
      typeof node === "string"
        ? compile(node)
        : Object.fromEntries(
            Object.entries(node as object).map(([k, v]) => [k, compileTree(v)])
          )
    const at = (tree: unknown, path: string): unknown =>
      path.split(".").reduce((n, k) => (n as Record<string, unknown>)[k], tree)
    const textOf = (compiled: unknown): string =>
      typeof compiled === "string"
        ? compiled
        : Array.isArray(compiled)
          ? compiled.map(textOf).join("")
          : ""

    beforeAll(async () => {
      const fromHere = createRequire(import.meta.url)
      const fromNextIntl = createRequire(fromHere.resolve("next-intl"))
      compile = (await import(fromNextIntl.resolve("icu-minify/compile")))
        .default as Compile
    })

    it("keeps the system's app name and the comment footer", () => {
      // identityDegradedHint 带 {bundleId}，编译后是数组
      expect(
        Array.isArray(
          at(
            compileTree(en),
            "DesktopNotificationSettings.identityDegradedHint"
          )
        )
      ).toBe(true)
      for (const catalog of [en, zhCN]) {
        const branded = brandMessages(
          compileTree(catalog) as AbstractIntlMessages
        )
        for (const key of SYSTEM_NAME_KEYS) {
          expect(textOf(at(branded, key)), key).toContain("CoTeam (dodoer)")
        }
        expect(
          textOf(at(branded, "Forge.settingsCommentFooterHint"))
        ).toContain(`🤖 Generated with ${COMMENT_FOOTER_NAME}`)
      }
    })

    for (const [locale, catalog] of [
      ["en", en],
      ["zh-CN", zhCN],
      ["zh-TW", zhTW],
      ["ja", ja],
      ["ko", ko],
      ["es", es],
      ["de", de],
      ["fr", fr],
      ["pt", pt],
      ["ar", ar],
    ] as const) {
      it(`brands the precompiled ${locale} catalog like the raw one`, () => {
        expect(
          brandMessages(compileTree(catalog) as AbstractIntlMessages)
        ).toEqual(compileTree(brandMessages(catalog as AbstractIntlMessages)))
      })
    }
  })

  it("builds document titles", () => {
    expect(brandTitle("Settings")).toBe(`Settings - ${PRODUCT_NAME}`)
    expect(brandTitle(null)).toBe(PRODUCT_NAME)
  })
})
