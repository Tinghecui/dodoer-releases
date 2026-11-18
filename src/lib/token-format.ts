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
 * Token counts for the usage page's lists, axes and hints: one decimal for K
 * and M, and a two-decimal B step from one billion up, so a large figure
 * reads "4.77B" rather than "4769M". Rounding that would print "1000K" or
 * "1000.0M" moves up a step instead. Other screens keep `formatTokenCount`.
 */
export function formatTokensCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0"
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "")
  if (n >= 999_950_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 999_950) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim(n / 1_000)}K`
  return Math.round(n).toLocaleString()
}
