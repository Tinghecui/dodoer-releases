import { allSelectChoices } from "@/lib/selectors-cache"
import type { SessionConfigOptionInfo } from "@/lib/types"

// Before a queued message leaves for the agent (jenny fork): compare the
// user's saved picks (model, effort, …) with what the live session actually
// uses. A pick made while the agent was still connecting may not have reached
// it yet — re-apply it. A pick the agent no longer offers falls back to the
// agent's current value, and the user is told.

export interface PreferenceMismatch {
  configId: string
  /** Display name of the option ("Model", "Effort", …). */
  name: string
  /** The value the user picked. */
  wanted: string
  /** Whether the live session still offers `wanted`. */
  available: boolean
  /** Display name of the value the session uses now. */
  currentName: string
}

export function diffConfigPreferences(
  prefs: Record<string, string> | null | undefined,
  live: readonly SessionConfigOptionInfo[] | null | undefined
): PreferenceMismatch[] {
  if (!prefs || !live) return []
  const out: PreferenceMismatch[] = []
  for (const opt of live) {
    const kind = opt.kind
    if (kind.type !== "select") continue
    const wanted = prefs[opt.id]
    if (wanted == null || wanted === kind.current_value) continue
    const choices = allSelectChoices(kind)
    const current = choices.find((c) => c.value === kind.current_value)
    out.push({
      configId: opt.id,
      name: opt.name,
      wanted,
      available: choices.some((c) => c.value === wanted),
      currentName: current?.name ?? kind.current_value,
    })
  }
  return out
}
