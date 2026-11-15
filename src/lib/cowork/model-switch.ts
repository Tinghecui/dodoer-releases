// Cowork fork: what a model switch says, and the switches each conversation's
// timeline shows.
//
// The backend reports a switch as it goes (`AcpEvent::ModelSwitch`, see the
// Rust `acp::model_switch`): the composer's picker shows the one under way
// (`ConnectionState.modelSwitch`), and the settled ones become lines in the
// conversation — those the server kept (`get_conversation_model_switches`),
// plus those that settle while this client watches (`appendModelSwitch`).

import { createContext, useEffect, useSyncExternalStore } from "react"
import { getConversationModelSwitches } from "@/lib/api"
import type { CoworkTextKey } from "@/lib/cowork/i18n"
import type { ModelSwitchInfo } from "@/lib/types"

type CoworkT = (key: CoworkTextKey, values?: Record<string, string>) => string

/** The model switch under way in the conversation whose composer this is
 *  (`ConnectionState.modelSwitch`), for the composer's settings picker. The
 *  conversation surfaces provide it; anywhere else there is none. */
export const ModelSwitchContext = createContext<ModelSwitchInfo | null>(null)

const EMPTY: readonly ModelSwitchInfo[] = []
const byConversation = new Map<number, readonly ModelSwitchInfo[]>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

/** Whether a switch is a line in the conversation: the agent took the model,
 *  or it is still on the old one. A replaced pick never reached it. */
export function isTimelineSwitch(s: ModelSwitchInfo): boolean {
  return s.phase === "applied" || s.phase === "failed"
}

function merge(
  current: readonly ModelSwitchInfo[],
  incoming: readonly ModelSwitchInfo[]
): readonly ModelSwitchInfo[] {
  const known = new Set(current.map((s) => s.id))
  const added = incoming.filter((s) => isTimelineSwitch(s) && !known.has(s.id))
  if (added.length === 0) return current
  return [...current, ...added].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at)
  )
}

function put(conversationId: number, incoming: readonly ModelSwitchInfo[]) {
  const current = byConversation.get(conversationId) ?? EMPTY
  const next = merge(current, incoming)
  if (next === current) return
  byConversation.set(conversationId, next)
  emit()
}

/** A switch that settled while this client watched (live event). */
export function appendModelSwitch(
  conversationId: number,
  s: ModelSwitchInfo
): void {
  put(conversationId, [s])
}

/** Fetch what the server kept for a conversation, merged with what this
 *  client saw meanwhile. A server without the route shows no lines. */
export async function loadModelSwitches(conversationId: number): Promise<void> {
  try {
    put(conversationId, await getConversationModelSwitches(conversationId))
  } catch {
    // Older server, or the conversation is gone: nothing to show.
  }
}

export function getModelSwitches(
  conversationId: number | null
): readonly ModelSwitchInfo[] {
  if (conversationId == null) return EMPTY
  return byConversation.get(conversationId) ?? EMPTY
}

/** The timeline's switches of a conversation (by its DB id; `null` for a draft
 *  with no row yet), fetched again whenever a view of it mounts — another
 *  device may have switched while none was open here. */
export function useModelSwitches(
  conversationId: number | null
): readonly ModelSwitchInfo[] {
  useEffect(() => {
    if (conversationId != null) void loadModelSwitches(conversationId)
  }, [conversationId])
  return useSyncExternalStore(
    subscribe,
    () => getModelSwitches(conversationId),
    () => EMPTY
  )
}

export function resetModelSwitchesForTest(): void {
  byConversation.clear()
}

/** Why a failed switch failed, in a few words. */
export function modelSwitchReason(t: CoworkT, s: ModelSwitchInfo): string {
  switch (s.failure) {
    case "no_answer":
      return t("modelSwitchNoAnswer")
    case "not_adopted":
      return t("modelSwitchNotAdopted")
    default:
      return t("modelSwitchAgentError", { detail: s.detail ?? "" })
  }
}

/** The sentence a settled switch reads as: its line in the conversation, and
 *  a failed one's toast. */
export function modelSwitchSentence(t: CoworkT, s: ModelSwitchInfo): string {
  if (s.phase === "applied") {
    return t("modelSwitchApplied", { from: s.from_name, to: s.to_name })
  }
  // The model the agent still reports, when it named one; else the one the
  // switch started from.
  const current =
    s.failure === "not_adopted" && s.detail ? s.detail : s.from_name
  return t("modelSwitchFailed", {
    to: s.to_name,
    reason: modelSwitchReason(t, s),
    current,
  })
}

/** What the picker's model chip reads while a switch is under way, and its
 *  tooltip. `null` when the switch is not under way. */
export function modelSwitchChip(
  t: CoworkT,
  s: ModelSwitchInfo | null | undefined
): { label: string; hint: string } | null {
  if (!s) return null
  if (s.phase === "pending") {
    const label = t("modelSwitchPending", { to: s.to_name })
    return { label, hint: label }
  }
  if (s.phase === "after_turn") {
    const values = { from: s.from_name, to: s.to_name }
    return {
      label: t("modelSwitchAfterTurn", values),
      hint: t("modelSwitchAfterTurnHint", values),
    }
  }
  return null
}

/** `HH:MM` in the viewer's locale. */
export function modelSwitchTime(at: string, locale: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

/**
 * Where each switch goes in a thread: above the first user message sent after
 * it (`before`, by that message's turn id), or under everything (`tail`).
 * `turns` are the thread's user messages in order, with their send times.
 * Switches older than the first loaded message are left out when earlier
 * history exists but is not loaded: they belong up there.
 */
export function placeModelSwitches(
  switches: readonly ModelSwitchInfo[],
  turns: readonly { id: string; timestamp: string }[],
  hasEarlierHistory: boolean
): {
  before: Map<string, ModelSwitchInfo[]>
  tail: ModelSwitchInfo[]
} {
  const before = new Map<string, ModelSwitchInfo[]>()
  const tail: ModelSwitchInfo[] = []
  const times = turns.map((turn) => Date.parse(turn.timestamp))
  for (const s of switches) {
    const at = Date.parse(s.at)
    const index = times.findIndex((time) => time > at)
    if (index === 0 && hasEarlierHistory) continue
    if (index === -1) {
      tail.push(s)
      continue
    }
    const id = turns[index].id
    const list = before.get(id)
    if (list) list.push(s)
    else before.set(id, [s])
  }
  return { before, tail }
}
