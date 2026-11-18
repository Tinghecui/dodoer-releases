import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// 活动时间线展示页的示例文字是写死的、不经过 brandMessages，
// 当产品名用的旧名字要直接写成 CoTeam。工具名、路径里的 codeg 不算。
const SOURCE = readFileSync(
  join(process.cwd(), "src/app/activity-gallery/page.gallery.tsx"),
  "utf8"
)

const PROSE_OLD_NAME_RE =
  /\b(?:in|to|of|from|by|with|the|use|open|restart|confirm in) (?:Codeg|codeg|dodoer|Dodoer|Cowork)\b(?![-_/.]\w)/g

describe("activity gallery sample text", () => {
  it("names the product CoTeam in the sample messages", () => {
    expect(SOURCE.match(PROSE_OLD_NAME_RE) ?? []).toEqual([])
    expect(SOURCE).toContain("until you confirm in CoTeam.")
  })
})
