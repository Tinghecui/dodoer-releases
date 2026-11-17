/**
 * 提交窗口的 `paths` 查询参数：从「变更」面板、文件树右键某个文件（目录）
 * 点「提交代码」时，带上这些路径，提交窗口只勾它们（#427）。
 * 值是 JSON 数组再 URL 编码，路径里有 `,`、`&` 都不会拆错。
 */
export const COMMIT_PATHS_PARAM = "paths"

/** 把路径拼到窗口地址后面；没有路径时原样返回。 */
export function appendCommitPathsParam(
  route: string,
  paths: readonly string[] | null | undefined
): string {
  const list = (paths ?? []).filter((path) => path.length > 0)
  if (list.length === 0) return route
  const sep = route.includes("?") ? "&" : "?"
  return `${route}${sep}${COMMIT_PATHS_PARAM}=${encodeURIComponent(
    JSON.stringify(list)
  )}`
}

/**
 * 读回查询参数（`URLSearchParams.get` 已经解过码）。没带参数返回 null；
 * 带了但读不出路径（不是 JSON 数组、空数组）返回 []，表示「带了但无效」，
 * 提交窗口就什么都不勾，不再当成没带参数去勾全部改动（#442）。
 */
export function parseCommitPathsParam(raw: string | null): string[] | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter(
      (item): item is string => typeof item === "string" && item.length > 0
    )
  } catch {
    return []
  }
}
