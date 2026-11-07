"use client"

import type {
  SessionConfigOptionInfo,
  SessionConfigSelectInfo,
  SessionConfigSelectOptionInfo,
  SessionModeStateInfo,
} from "@/lib/types"

/** Every choice of a select option, flat and grouped. */
export function allSelectChoices(
  kind: SessionConfigSelectInfo
): SessionConfigSelectOptionInfo[] {
  return [
    ...(kind.options ?? []),
    ...(kind.groups ?? []).flatMap((g) => g.options ?? []),
  ]
}

// Per-agent cache of the composer's selector lists (modes / config options such
// as model and effort) — jenny fork.
//
// Upstream kept this cache in memory only, so after every app start the model
// and effort pickers showed a skeleton until the agent finished connecting.
// Persisting it lets the composer show the last known lists at once; the live
// lists from the agent overwrite the entry as soon as they arrive.

export interface CachedSelectors {
  modes: SessionModeStateInfo | null
  configOptions: SessionConfigOptionInfo[] | null
}

const STORAGE_KEY = "jenny:selectors-cache:v1"

let entries: Map<string, CachedSelectors> | null = null
let version = 0
const listeners = new Set<() => void>()

function load(): Map<string, CachedSelectors> {
  if (entries) return entries
  entries = new Map()
  if (typeof window === "undefined") return entries
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return entries
    const parsed = JSON.parse(raw) as Record<string, CachedSelectors>
    for (const [agentType, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue
      entries.set(agentType, {
        modes: value.modes ?? null,
        configOptions: Array.isArray(value.configOptions)
          ? value.configOptions
          : null,
      })
    }
  } catch {
    // Corrupt entry: start empty, the next live list rewrites it.
  }
  return entries
}

function persist(): void {
  if (typeof window === "undefined" || !entries) return
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries))
    )
  } catch {
    // Storage full or unavailable: the in-memory cache still works.
  }
}

function emit(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** Map-compatible facade used by the ACP connections context. */
export const selectorsCache = {
  get(agentType: string): CachedSelectors | undefined {
    return load().get(agentType)
  },
  has(agentType: string): boolean {
    return load().has(agentType)
  },
  set(agentType: string, value: CachedSelectors): void {
    // Store a copy: callers mutate the entry they read before setting it.
    load().set(agentType, {
      modes: value.modes,
      configOptions: value.configOptions,
    })
    persist()
    emit()
  },
}

/** Show a selection the user made before the agent connected, so the picker
 *  reflects it immediately. */
export function setCachedConfigValue(
  agentType: string,
  configId: string,
  valueId: string
): void {
  const entry = load().get(agentType)
  if (!entry?.configOptions) return
  let changed = false
  const configOptions = entry.configOptions.map((opt) => {
    if (opt.id !== configId || opt.kind.type !== "select") return opt
    if (!allSelectChoices(opt.kind).some((o) => o.value === valueId)) return opt
    if (opt.kind.current_value === valueId) return opt
    changed = true
    return { ...opt, kind: { ...opt.kind, current_value: valueId } }
  })
  if (changed) selectorsCache.set(agentType, { ...entry, configOptions })
}

export function subscribeSelectorsCache(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSelectorsCacheVersion(): number {
  return version
}

/** Test hook: drop the in-memory copy so the next read reloads storage. */
export function resetSelectorsCacheForTests(): void {
  entries = null
  version = 0
  listeners.clear()
}
