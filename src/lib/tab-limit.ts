// Tab-count caps (jenny fork).
//
// The conversation tab strip keeps at most MAX_CONVERSATION_TABS tabs and the
// side file panel at most MAX_FILE_TABS. When a new tab pushes a strip over
// its cap, the tabs the user has used least recently close first.

export const MAX_CONVERSATION_TABS = 5
export const MAX_FILE_TABS = 3

/**
 * Remembers when each tab was last opened or activated. A tab seen for the
 * first time counts as used at that moment, so a tab that has just been added
 * (and is not active yet) is never the first to go.
 */
export class TabRecency {
  private seq = 0
  private readonly usedAt = new Map<string, number>()

  /** Record the current tab list. Forget gone ids. Stamp the active tab, then
   *  new ids in strip order, so a tab opened in the background ranks as more
   *  recent than the active one. A new tab that is also active ranks first. */
  sync(tabIds: readonly string[], activeId: string | null): void {
    const present = new Set(tabIds)
    for (const id of this.usedAt.keys()) {
      if (!present.has(id)) this.usedAt.delete(id)
    }
    const activeIsNew = activeId != null && !this.usedAt.has(activeId)
    if (activeId != null && !activeIsNew) this.touch(activeId)
    for (const id of tabIds) {
      if (!this.usedAt.has(id)) this.usedAt.set(id, ++this.seq)
    }
    if (activeIsNew && present.has(activeId)) this.touch(activeId)
  }

  touch(id: string): void {
    if (this.usedAt.get(id) === this.seq) return
    this.usedAt.set(id, ++this.seq)
  }

  usedAtOf(id: string): number {
    return this.usedAt.get(id) ?? 0
  }

  clear(): void {
    this.usedAt.clear()
    this.seq = 0
  }
}

/**
 * The tabs to close so that at most `limit` remain, least recently used
 * first. The most recently used tab (usually the one just opened) and tabs
 * for which `keep` returns true are never picked, so the result can leave
 * more than `limit` tabs open when too many must be kept.
 */
export function pickTabsToEvict(
  tabIds: readonly string[],
  limit: number,
  recency: Pick<TabRecency, "usedAtOf">,
  keep: (id: string) => boolean
): string[] {
  const excess = tabIds.length - limit
  if (excess <= 0) return []
  const ranked = tabIds
    .map((id, index) => ({ id, index, usedAt: recency.usedAtOf(id) }))
    .sort((a, b) => a.usedAt - b.usedAt || a.index - b.index)
  return ranked
    .slice(0, -1)
    .filter(({ id }) => !keep(id))
    .slice(0, excess)
    .map(({ id }) => id)
}
