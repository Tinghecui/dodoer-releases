import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { PRODUCT_NAME } from "@/lib/cowork/brand"
import { AppBootLoading } from "./app-boot-loading"

afterEach(cleanup)

describe("AppBootLoading", () => {
  // AI QA #93: the splash said "codeg" in a Cowork deployment. It renders
  // before any messages are loaded, so the name is the brand constant.
  it("shows the product name, not the internal one", () => {
    const { container } = render(<AppBootLoading />)
    expect(container.textContent).toBe(PRODUCT_NAME)
    expect(container.textContent).not.toMatch(/codeg/i)
  })
})
