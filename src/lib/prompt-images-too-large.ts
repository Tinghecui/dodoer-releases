/**
 * Recognizing the backend's "the images in this message are too big for the
 * agent" prompt rejection across transports.
 *
 * The Claude and Codex adapters read one ACP message of at most 32 MiB and
 * drop the connection on a bigger one, so the backend refuses a prompt whose
 * images come to more than its cap once base64-encoded
 * (`acp::prompt_hydration`). `AcpError::PromptImagesTooLarge` serializes to its
 * Display string on Tauri and becomes `AppCommandError.message` on the web
 * path, so — as with `conversation-moved.ts` — it is recognized by a
 * backend-controlled marker, and the two sizes are read back out of that same
 * string (`AcpError::prompt_images_too_large` builds it: keep the two in step).
 */

/** Substring of the backend sentence `the images in this message are too big
 *  for the agent to accept (<size> MiB once encoded, the limit is <limit>
 *  MiB). Send fewer or smaller images.` */
const PROMPT_IMAGES_TOO_LARGE_MARKER = "too big for the agent to accept"
const SIZES_PATTERN =
  /\((\d+(?:\.\d+)?) MiB once encoded, the limit is (\d+) MiB\)/

/** The sizes the refusal named, as the backend wrote them (MiB). */
export interface PromptImagesTooLarge {
  size: string
  limit: string
}

function rejectionMessage(err: unknown): string | null {
  if (typeof err === "string") return err
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return null
}

/** The sizes when `err` is the backend's "images too big for the agent"
 *  refusal, or null when it is some other failure — or when the sizes cannot
 *  be read, in which case the caller shows the backend's own (English) words,
 *  which say the same. */
export function asPromptImagesTooLarge(
  err: unknown
): PromptImagesTooLarge | null {
  const message = rejectionMessage(err)
  if (message == null || !message.includes(PROMPT_IMAGES_TOO_LARGE_MARKER)) {
    return null
  }
  const match = SIZES_PATTERN.exec(message)
  return match ? { size: match[1], limit: match[2] } : null
}
