// The resource meter's data: CPU, memory, swap and disk of the machine the
// workspace's daemon runs on (`src-tauri/src/system_resources.rs`). In a
// browser or a remote window that is the server; in the local workspace, this
// computer.
//
// One poller per window, shared by every mounted meter and alive only while
// one is mounted: every POLL_MS, every WATCH_POLL_MS while a meter's popover
// is open, not at all while the window is hidden. The server caches its
// sample for a second, so several windows cost it no more than one.
//
// A server from before the route answers `not_implemented`, and Windows
// reports no figures: both read as "unsupported", and the meter stays hidden.

import { useEffect, useSyncExternalStore } from "react"
import { getTransport } from "@/lib/transport"

export type MemoryPressure = "normal" | "warning" | "critical"

export interface SystemResources {
  /** Unix millis of the server's sample. */
  sampledAt: number
  cpu: {
    /** 0–100 across all cores. */
    usagePercent: number | null
    cores: number
    /** 1, 5 and 15 minute load averages. */
    loadAverage: [number, number, number] | null
  } | null
  memory: { totalBytes: number; availableBytes: number } | null
  swap: { totalBytes: number; usedBytes: number } | null
  disk: { path: string; totalBytes: number; availableBytes: number } | null
  /** Linux service or container: the workspace's own processes (its cgroup),
   *  and the tightest memory limit above them, if any. */
  workspace: {
    usedBytes: number
    limit: { limitBytes: number; usedBytes: number } | null
  } | null
  /** Decided by the server: from the headroom left on Linux, from the
   *  kernel's own verdict on macOS. */
  memoryPressure: MemoryPressure
}

/** One point of the trend lines: usage in percent at a moment. */
export interface ResourceSample {
  at: number
  cpu: number | null
  memory: number | null
}

export interface ResourcesState {
  latest: SystemResources | null
  /** The last HISTORY_MS of samples, oldest first. */
  history: ResourceSample[]
  /** False once the server turned out to have no figures to give. */
  supported: boolean
}

export const POLL_MS = 5_000
export const WATCH_POLL_MS = 2_000
export const HISTORY_MS = 5 * 60_000
/** Failed polls in a row after which the last reading is dropped: a stale
 *  "58%" is worse than no figure. */
export const MAX_FAILURES = 2

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null
}

export function normalizeSystemResources(raw: unknown): SystemResources | null {
  const r = record(raw)
  if (!r) return null

  const rawCpu = record(r.cpu)
  const load =
    rawCpu && Array.isArray(rawCpu.load_average) ? rawCpu.load_average : []
  const cpu = rawCpu
    ? {
        usagePercent: num(rawCpu.usage_percent),
        cores: num(rawCpu.cores) ?? 1,
        loadAverage:
          load.length === 3 && load.every((v) => num(v) !== null)
            ? (load as [number, number, number])
            : null,
      }
    : null

  // A total and a part of it; null unless both are there and the total is
  // positive. The part is clamped into the total.
  const pair = (
    value: unknown,
    totalKey: string,
    partKey: string
  ): { total: number; part: number } | null => {
    const v = record(value)
    const total = v ? num(v[totalKey]) : null
    const part = v ? num(v[partKey]) : null
    if (!total || part === null) return null
    return { total, part: Math.min(part, total) }
  }

  const memory = pair(r.memory, "total_bytes", "available_bytes")
  const swap = pair(r.swap, "total_bytes", "used_bytes")
  const disk = pair(r.disk, "total_bytes", "available_bytes")
  const diskPath = record(r.disk)?.path
  const pressure = r.memory_pressure
  const rawWorkspace = record(r.workspace)
  const workspaceUsed = rawWorkspace ? num(rawWorkspace.used_bytes) : null
  const limit = rawWorkspace
    ? pair(rawWorkspace.limit, "limit_bytes", "used_bytes")
    : null

  return {
    sampledAt: num(r.sampled_at) ?? 0,
    cpu,
    memory: memory && {
      totalBytes: memory.total,
      availableBytes: memory.part,
    },
    swap: swap && { totalBytes: swap.total, usedBytes: swap.part },
    disk: disk && {
      path: typeof diskPath === "string" ? diskPath : "",
      totalBytes: disk.total,
      availableBytes: disk.part,
    },
    workspace:
      workspaceUsed === null
        ? null
        : {
            usedBytes: workspaceUsed,
            limit: limit && { limitBytes: limit.total, usedBytes: limit.part },
          },
    memoryPressure:
      pressure === "warning" || pressure === "critical" ? pressure : "normal",
  }
}

/**
 * The memory figure that matters: the host's, unless the workspace runs under
 * a limit that is closer to full — then that limit is what it will hit first.
 */
export function memoryHeadline(resources: SystemResources): {
  usedRatio: number
  availableBytes: number
  totalBytes: number
  /** The figures are the cgroup limit's, not the machine's. */
  limited: boolean
} | null {
  const { memory } = resources
  const limit = resources.workspace?.limit ?? null
  const host = memory && {
    usedRatio: 1 - memory.availableBytes / memory.totalBytes,
    availableBytes: memory.availableBytes,
    totalBytes: memory.totalBytes,
    limited: false,
  }
  const capped = limit && {
    usedRatio: limit.usedBytes / limit.limitBytes,
    availableBytes: limit.limitBytes - limit.usedBytes,
    totalBytes: limit.limitBytes,
    limited: true,
  }
  if (host && capped) return capped.usedRatio > host.usedRatio ? capped : host
  return host ?? capped
}

const GIB = 1024 ** 3
const MIB = 1024 ** 2

/** `7.8 GB`, `512 MB`: binary units under the names people say. */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) {
    const gb = bytes / GIB
    return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`
  }
  return `${Math.round(bytes / MIB)} MB`
}

/** `4.6 / 7.8 GB`; the unit is said once when both sides share it. */
export function formatBytesOf(part: number, total: number): string {
  const [a, b] = [formatBytes(part), formatBytes(total)]
  const unit = b.slice(b.indexOf(" "))
  return a.endsWith(unit) ? `${a.slice(0, -unit.length)} / ${b}` : `${a} / ${b}`
}

export function formatPercent(ratio: number): string {
  return `${Math.round(Math.min(Math.max(ratio, 0), 1) * 100)}%`
}

// ── The poller ──────────────────────────────────────────────────────────

const EMPTY: ResourcesState = { latest: null, history: [], supported: true }

let state: ResourcesState = EMPTY
const listeners = new Set<() => void>()
let watchers = 0
let timer: ReturnType<typeof setTimeout> | undefined
let inflight = false
let failures = 0
// Bumped whenever polling stops, so an answer still on its way is dropped.
let generation = 0

function publish(next: ResourcesState) {
  state = next
  for (const listener of listeners) listener()
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.hidden
}

function schedule() {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  if (listeners.size === 0 || !state.supported || hidden()) return
  timer = setTimeout(
    () => {
      timer = undefined
      void poll()
    },
    watchers > 0 ? WATCH_POLL_MS : POLL_MS
  )
}

async function poll(): Promise<void> {
  if (inflight || listeners.size === 0 || !state.supported || hidden()) return
  inflight = true
  const mine = generation
  try {
    const raw = await getTransport().call<unknown>("get_system_resources", {})
    if (mine !== generation) return
    const latest = normalizeSystemResources(raw)
    failures = 0
    if (!latest || (!latest.cpu && !latest.memory)) {
      publish({ latest: null, history: [], supported: false })
      return
    }
    const at = Date.now()
    const headline = memoryHeadline(latest)
    publish({
      latest,
      history: [
        ...state.history.filter((sample) => at - sample.at < HISTORY_MS),
        {
          at,
          cpu: latest.cpu?.usagePercent ?? null,
          memory: headline ? headline.usedRatio * 100 : null,
        },
      ],
      supported: true,
    })
  } catch (err: unknown) {
    if (mine !== generation) return
    if ((err as { code?: unknown } | null)?.code === "not_implemented") {
      publish({ latest: null, history: [], supported: false })
      return
    }
    failures += 1
    if (failures >= MAX_FAILURES && state.latest) {
      publish({ ...state, latest: null })
    }
  } finally {
    inflight = false
    if (mine === generation) schedule()
  }
}

function onVisibilityChange() {
  if (hidden()) {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  } else if (timer === undefined) {
    void poll()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", onVisibilityChange)
    void poll()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    document.removeEventListener("visibilitychange", onVisibilityChange)
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    generation += 1
    inflight = false
  }
}

const getSnapshot = () => state
const getServerSnapshot = () => EMPTY

/** The latest reading and its recent history; polls while mounted. */
export function useSystemResources(): ResourcesState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** Poll faster while `active` (someone is looking at the figures), starting
 *  with a fresh reading right away. */
export function useResourceWatch(active: boolean): void {
  useEffect(() => {
    if (!active) return
    watchers += 1
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
      void poll()
    }
    return () => {
      watchers -= 1
    }
  }, [active])
}

// One notification per episode: armed again only once memory is back to
// normal, so a reading that hovers around the critical line does not repeat it.
let announced = false

/** True the first time `pressure` is critical since it was last normal. */
export function shouldAnnounceCritical(pressure: MemoryPressure): boolean {
  if (pressure === "normal") {
    announced = false
    return false
  }
  if (pressure !== "critical" || announced) return false
  announced = true
  return true
}

/** Test hook: forget everything, stop polling. */
export function resetSystemResourcesForTests(): void {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  generation += 1
  inflight = false
  failures = 0
  watchers = 0
  announced = false
  listeners.clear()
  state = EMPTY
}
