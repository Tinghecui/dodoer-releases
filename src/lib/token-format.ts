export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`
  }
  return n.toLocaleString()
}

/**
 * Token counts everywhere a figure is shown (usage page, session details,
 * turn footers, context meter, tasks): one decimal for K
 * and M, and a two-decimal B step from one billion up, so a large figure
 * reads "4.77B" rather than "4769M". Rounding that would print "1000K" or
 * "1000.0M" moves up a step instead. `formatTokenCount` (no B step) is kept
 * only for compatibility; new display code should not use it (#742).
 */
export function formatTokensCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0"
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "")
  if (n >= 999_950_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 999_950) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim(n / 1_000)}K`
  return Math.round(n).toLocaleString()
}
