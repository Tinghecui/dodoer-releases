import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

// A full-page route folds the aux column to 0 with the panel still mounted.
// jsdom has no layout, so these lock the two things that make the fold real.
//
// The regression they guard against: the column is `overflow: visible` for the
// card's shadow, which turns the flex item's `min-width: auto` on and held it
// at the card's content width, so the session panel stood beside the Apps list
// (and beside every other route's page) as a second sidebar.
const layout = readFileSync(
  resolve(process.cwd(), "src/app/workspace/layout.tsx"),
  "utf8"
)

describe("the aux column folds away for a full-page route", () => {
  it("lets the unclipped column shrink below its content", () => {
    const style = layout.match(
      /const auxPanelStyle = useMemo\([\s\S]*?\n {2}\)/
    )
    expect(style?.[0]).toContain("minWidth: 0")
    expect(style?.[0]).toContain('overflow: "visible"')
  })

  it("stops the folded card painting", () => {
    expect(layout).toMatch(
      /!auxOpen && "conversation-tab-hidden invisible"\s*\)\s*\}\s*>\s*\{auxElement\}/
    )
  })

  it("keeps the panel collapsed off the route, not just its toggle", () => {
    expect(layout).toContain(
      "const auxOpen = auxOpenRequested && isConversations"
    )
  })
})
