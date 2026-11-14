import { describe, expect, it } from "vitest"

import cases from "./scrub-cases.json"
import {
  MAX_CHARS,
  dropsField,
  scrubRecord,
  scrubText,
  scrubValue,
} from "./scrub"

// The same cases as `src-tauri/src/telemetry/scrub.rs`: both sides scrub
// alike.
describe("shared scrub cases", () => {
  it.each(cases.text)("$name", ({ in: input, out }) => {
    expect(scrubText(input)).toBe(out)
  })
  it.each(cases.fields)("$name", ({ in: input, out }) => {
    expect(scrubValue(input)).toEqual(out)
  })
})

describe("scrubText", () => {
  it("cuts long messages by characters", () => {
    const out = scrubText("a".repeat(MAX_CHARS + 100))
    expect(Array.from(out)).toHaveLength(MAX_CHARS + 1)
    expect(out.endsWith("…")).toBe(true)
    expect(Array.from(scrubText("错".repeat(MAX_CHARS + 1)))).toHaveLength(
      MAX_CHARS + 1
    )
    expect(scrubText("short")).toBe("short")
  })

  it("scrubs every occurrence, not just the first", () => {
    expect(scrubText("a@b.co and c@d.io")).toBe("<email> and <email>")
  })
})

describe("dropsField", () => {
  it("matches on the last segment, case-insensitively", () => {
    expect(dropsField("working_dir")).toBe(true)
    expect(dropsField("code.file.path")).toBe(true)
    expect(dropsField("connection:CWD")).toBe(true)
    expect(dropsField("code.module.name")).toBe(false)
    expect(dropsField("paths_checked")).toBe(false)
  })

  it("scrubRecord drops and scrubs", () => {
    expect(scrubRecord({ cwd: "/home/a/b", note: "mail a@b.co" })).toEqual({
      note: "mail <email>",
    })
  })
})
