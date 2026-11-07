import { create } from "zustand"

/**
 * jenny fork: what the canvas route shows and how the conversation mind map
 * is folded, remembered in localStorage per browser profile like the rest of
 * the canvas view state (`canvas-view-storage.ts`).
 *
 * - `mode`: the mind map (the default) or the free-form canvas boards.
 * - `projectId`: the root folder whose map is open.
 * - `collapsed`: per project, the categories folded shut.
 * - `focus`: a category to bring to the middle of the map once it is drawn
 *   (from a conversation's breadcrumb); session only.
 */
export type CanvasMode = "mindmap" | "boards"

const MODE_KEY = "jenny:canvas-mode:v1"
const PROJECT_KEY = "jenny:mindmap-project:v1"
const COLLAPSED_KEY_PREFIX = "jenny:mindmap-collapsed:v1:"

function read(key: string): string | null {
  try {
    return typeof window === "undefined"
      ? null
      : window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (typeof window === "undefined") return
    if (value == null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Storage full or blocked: the view simply is not remembered.
  }
}

function readCollapsed(projectId: number): string[] {
  const raw = read(`${COLLAPSED_KEY_PREFIX}${projectId}`)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : []
  } catch {
    return []
  }
}

interface MindMapViewState {
  mode: CanvasMode
  projectId: number | null
  /** Folded categories of the open project. */
  collapsed: ReadonlySet<string>
  /** Per category of the open project, how many leaves to show. Session
   *  only: a fresh visit starts compact. */
  leafLimits: ReadonlyMap<string, number>
  focus: { categoryId: string; nonce: number } | null
  setMode: (mode: CanvasMode) => void
  setProject: (projectId: number | null) => void
  toggleCollapsed: (categoryId: string) => void
  setCollapsed: (categoryIds: Iterable<string>) => void
  showMore: (categoryId: string, by: number, current: number) => void
  /** Show the map of `projectId` with `path` (top-level category first)
   *  unfolded and its last category asked into view. */
  focusCategory: (projectId: number, path: readonly string[]) => void
  clearFocus: () => void
}

function initialMode(): CanvasMode {
  return read(MODE_KEY) === "boards" ? "boards" : "mindmap"
}

function initialProject(): number | null {
  const raw = Number(read(PROJECT_KEY))
  return Number.isInteger(raw) && raw > 0 ? raw : null
}

export const useMindMapViewStore = create<MindMapViewState>((set, get) => {
  const projectId = initialProject()
  return {
    mode: initialMode(),
    projectId,
    collapsed: new Set(projectId == null ? [] : readCollapsed(projectId)),
    leafLimits: new Map(),
    focus: null,

    setMode: (mode) => {
      write(MODE_KEY, mode)
      set({ mode })
    },

    setProject: (next) => {
      if (next === get().projectId) return
      write(PROJECT_KEY, next == null ? null : String(next))
      set({
        projectId: next,
        collapsed: new Set(next == null ? [] : readCollapsed(next)),
        leafLimits: new Map(),
      })
    },

    toggleCollapsed: (categoryId) => {
      const next = new Set(get().collapsed)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      get().setCollapsed(next)
    },

    setCollapsed: (categoryIds) => {
      const next = new Set(categoryIds)
      const { projectId } = get()
      if (projectId != null) {
        write(
          `${COLLAPSED_KEY_PREFIX}${projectId}`,
          next.size === 0 ? null : JSON.stringify([...next])
        )
      }
      set({ collapsed: next })
    },

    showMore: (categoryId, by, current) => {
      const next = new Map(get().leafLimits)
      next.set(categoryId, current + by)
      set({ leafLimits: next })
    },

    focusCategory: (projectId, path) => {
      const last = path[path.length - 1]
      if (last == null) return
      const { setMode, setProject, setCollapsed } = get()
      setMode("mindmap")
      setProject(projectId)
      const folded = new Set(get().collapsed)
      for (const id of path) folded.delete(id)
      setCollapsed(folded)
      set({ focus: { categoryId: last, nonce: (get().focus?.nonce ?? 0) + 1 } })
    },

    clearFocus: () => set({ focus: null }),
  }
})
