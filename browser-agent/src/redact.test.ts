import { afterEach, describe, expect, it } from "vitest"

import { snapshot } from "./index"
import { HIDDEN_VALUE, isSecretField, withSecretsHidden } from "./redact"

/**
 * The tree is Playwright's and reports a text field's value as its content
 * (`- textbox "Password": <value>`), password fields included. These pin that
 * a secret field's value never reaches the tree while every other field's
 * still does. jsdom gives every box zero size, so the tree has no refs here,
 * but the values are rendered all the same, which is what is under test.
 */

const SECRET = "example-secret-42"
/** How the renderer writes the marker: YAML quotes a scalar opening with `[`. */
const SHOWN_HIDDEN = JSON.stringify(HIDDEN_VALUE)

function mount(html: string): void {
  document.body.innerHTML = html
}

/** Set as a property, the way a person typing or a browser autofilling does
 *  — not as the `value` attribute. */
function fill(selector: string, value: string): void {
  const el = document.querySelector(selector) as
    | HTMLInputElement
    | HTMLTextAreaElement
  el.value = value
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("snapshot hides secret fields", () => {
  it("hides a password field's value and keeps a plain field's", () => {
    mount(
      `<label>User <input id="u" type="text"></label>` +
        `<label>Password <input id="p" type="password"></label>`
    )
    fill("#u", "plain-user")
    fill("#p", SECRET)

    const tree = snapshot().tree
    expect(tree).not.toContain(SECRET)
    expect(tree).toContain(`textbox "Password": ${SHOWN_HIDDEN}`)
    expect(tree).toContain(`textbox "User": plain-user`)
  })

  it("hides a value the page wrote into the markup", () => {
    mount(`<input aria-label="Password" type="password" value="${SECRET}">`)
    expect(snapshot().tree).not.toContain(SECRET)
  })

  it("leaves an empty secret field empty, so it still reads as unfilled", () => {
    mount(`<input aria-label="Password" type="password">`)
    const tree = snapshot().tree
    expect(tree).not.toContain(HIDDEN_VALUE)
    expect(tree).toContain(`textbox "Password"`)
  })

  it("hides fields marked secret by autocomplete, whatever their type", () => {
    mount(
      `<input id="a" aria-label="Current" autocomplete="current-password">` +
        `<input id="b" aria-label="New" autocomplete="section-x new-password">` +
        `<input id="c" aria-label="Code" inputmode="numeric" autocomplete="one-time-code">` +
        `<input id="d" aria-label="Card" autocomplete="billing cc-number">` +
        `<input id="e" aria-label="CVC" autocomplete="CC-CSC">` +
        `<input id="f" aria-label="Email" autocomplete="email">`
    )
    for (const id of ["a", "b", "c", "d", "e"])
      fill(`#${id}`, `${SECRET}-${id}`)
    fill("#f", "someone@example.com")

    const tree = snapshot().tree
    expect(tree).not.toContain(SECRET)
    for (const name of ["Current", "New", "Code", "Card", "CVC"])
      expect(tree).toContain(`textbox "${name}": ${SHOWN_HIDDEN}`)
    expect(tree).toContain(`textbox "Email": someone@example.com`)
  })

  it("keeps the value out of another control's name, too", () => {
    // A field inside a control's label becomes part of that control's name
    // — Playwright reads its value there as well.
    mount(
      `<input type="checkbox" id="k">` +
        `<label for="k">Remember <input type="password" id="p"></label>`
    )
    fill("#p", SECRET)
    expect(snapshot().tree).not.toContain(SECRET)
  })

  it("covers a field inside an open shadow root", () => {
    mount(`<div id="host"></div>`)
    const shadow = document.getElementById("host")!.attachShadow({
      mode: "open",
    })
    shadow.innerHTML = `<input aria-label="Password" type="password">`
    ;(shadow.querySelector("input") as HTMLInputElement).value = SECRET
    expect(snapshot().tree).not.toContain(SECRET)
  })
})

describe("withSecretsHidden", () => {
  it("restores the real value once the read is over, even after a throw", () => {
    mount(`<input id="p" type="password">`)
    fill("#p", SECRET)
    const el = document.getElementById("p") as HTMLInputElement

    expect(withSecretsHidden(() => el.value)).toBe(HIDDEN_VALUE)
    expect(el.value).toBe(SECRET)
    expect(() =>
      withSecretsHidden(() => {
        throw new Error("boom")
      })
    ).toThrow("boom")
    expect(el.value).toBe(SECRET)
    // Writing still works while hidden; only reading is shadowed.
    withSecretsHidden(() => {
      el.value = "changed"
    })
    expect(el.value).toBe("changed")
  })
})

describe("isSecretField", () => {
  it("is password fields and secret autofill tokens only", () => {
    mount(
      `<input id="pw" type="PASSWORD">` +
        `<input id="txt" type="text">` +
        `<input id="name" autocomplete="cc-name">` +
        `<input id="user" autocomplete="username">` +
        `<textarea id="ta" autocomplete="one-time-code"></textarea>` +
        `<textarea id="plain"></textarea>` +
        `<div id="div" autocomplete="current-password"></div>`
    )
    const secret = (id: string) => isSecretField(document.getElementById(id)!)
    expect(secret("pw")).toBe(true)
    expect(secret("name")).toBe(true)
    expect(secret("ta")).toBe(true)
    expect(secret("txt")).toBe(false)
    expect(secret("user")).toBe(false)
    expect(secret("plain")).toBe(false)
    expect(secret("div")).toBe(false)
  })
})
