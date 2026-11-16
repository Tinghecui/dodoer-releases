import { describe, expect, it } from "vitest"

import { asPromptImagesTooLarge } from "./prompt-images-too-large"

// Exactly what `AcpError::prompt_images_too_large` writes (pinned on the Rust
// side by `the_too_big_images_message_names_both_sizes`).
const REFUSAL =
  "the images in this message are too big for the agent to accept " +
  "(40.5 MiB once encoded, the limit is 30 MiB). Send fewer or smaller images."

describe("asPromptImagesTooLarge", () => {
  it("reads the Tauri rejection (the bare Display string) and its sizes", () => {
    expect(asPromptImagesTooLarge(REFUSAL)).toEqual({
      size: "40.5",
      limit: "30",
    })
  })

  it("reads the web rejection (an AppCommandError body)", () => {
    expect(
      asPromptImagesTooLarge({ code: "invalid_input", message: REFUSAL })
    ).toEqual({ size: "40.5", limit: "30" })
  })

  it("leaves a refusal whose sizes it cannot read to the backend's words", () => {
    expect(
      asPromptImagesTooLarge("images too big for the agent to accept")
    ).toBeNull()
  })

  it("is null for any other failure", () => {
    expect(
      asPromptImagesTooLarge(
        "ACP protocol error: image attachment unavailable: /uploads/x.png"
      )
    ).toBeNull()
    expect(asPromptImagesTooLarge(new Error("boom"))).toBeNull()
    expect(asPromptImagesTooLarge(null)).toBeNull()
  })
})
