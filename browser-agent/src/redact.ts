/**
 * Keeping secret fields out of the tree an agent reads.
 *
 * Playwright's tree reports a text field's current value as the field's
 * content — `- textbox "Password": <whatever is in it>` — and does so for a
 * password field exactly as for any other (`injected/ariaSnapshot.ts`,
 * `toAriaNode`: `result.children = [element.value]`). In the person's own
 * Chrome that value may be a password the browser filled in by itself, on a
 * page the person is signed in to. So while the tree is built, a secret
 * field's value reads as [`HIDDEN_VALUE`] instead.
 *
 * Done by shadowing the `value` getter rather than by editing the tree
 * afterwards, for two reasons. The value is read in more than one place —
 * the field's content, and the accessible name of a control whose `<label>`
 * has the field inside it (`roleUtils.ts`, the embedded-control step) — and
 * a getter covers every reader, including any a later Playwright adds. And
 * it leaves the vendored sources byte-identical (`vendor/playwright/VENDOR.md`).
 *
 * The prototype patched is this world's own: in an isolated world the page
 * has a different `HTMLInputElement.prototype` and never sees the change, and
 * the patch is undone before `withSecretsHidden` returns, synchronously, so
 * acting on a field (`act.ts`, which reads and writes `value` too) is never
 * affected.
 *
 * Only secret fields. Every other field keeps showing its value, because an
 * agent filling a form needs to see what it typed and what the page put
 * there.
 */

/** What a secret field's value reads as in the tree, when it has one. */
export const HIDDEN_VALUE = "[hidden]"

/** Autofill tokens (HTML `autocomplete`) that mark a field as secret on
 *  their own, whatever the field's `type`. */
const SECRET_AUTOFILL = new Set([
  "current-password",
  "new-password",
  "one-time-code",
])

/**
 * Whether a field's value is a secret: a password field, or a field whose
 * `autocomplete` names a password, a one-time code or any part of a payment
 * card (`cc-number`, `cc-csc`, `cc-exp`, …).
 *
 * `autocomplete` is read as a token list because that is what it is — a
 * section, a `shipping`/`billing` hint and a trailing `webauthn` can all
 * stand beside the token that matters. A password field the page has turned
 * into `type="text"` to show what was typed is caught by its `autocomplete`
 * when it has one; when it has none, the page is showing the value on screen
 * anyway.
 */
export function isSecretField(el: Element): boolean {
  const isInput = el instanceof HTMLInputElement
  if (!isInput && !(el instanceof HTMLTextAreaElement)) return false
  if (isInput && el.type === "password") return true
  const tokens = (el.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/)
  return tokens.some((t) => SECRET_AUTOFILL.has(t) || t.startsWith("cc-"))
}

/**
 * Run `read` with every secret field's value reading as [`HIDDEN_VALUE`] —
 * or as `""` when the field is empty, so an agent can still tell a field it
 * has to fill from one that is filled.
 *
 * Fails closed: an engine without a configurable `value` accessor on the
 * prototype (WebIDL requires one; no engine we ship on lacks it) gets an
 * error rather than a tree with the secrets left in.
 */
export function withSecretsHidden<T>(read: () => T): T {
  const undo: (() => void)[] = []
  try {
    for (const proto of [
      HTMLInputElement.prototype,
      HTMLTextAreaElement.prototype,
    ]) {
      const own = Object.getOwnPropertyDescriptor(proto, "value")
      const get = own?.get
      if (!own || !get || !own.configurable)
        throw new Error("cannot hide secret fields in this engine")
      Object.defineProperty(proto, "value", {
        ...own,
        get(this: HTMLInputElement | HTMLTextAreaElement) {
          const value = get.call(this) as string
          return value && isSecretField(this) ? HIDDEN_VALUE : value
        },
      })
      undo.push(() => Object.defineProperty(proto, "value", own))
    }
    return read()
  } finally {
    for (const restore of undo) restore()
  }
}
