/**
 * 提交窗口的 `paths` 查询参数：从「变更」面板、文件树右键某个文件（目录）
 * 点「提交代码」时，带上这些路径，提交窗口只勾它们（#427）。
 * 值是 JSON 数组再 URL 编码，路径里有 `,`、`&` 都不会拆错。
 */
export const COMMIT_PATHS_PARAM = "paths"

/**
 * 提交窗口的 `scope` 查询参数：只勾某一组改动（#528）。右键「未跟踪」分组的
 * 根只带 `scope=untracked`，不再把每个未跟踪文件都列进地址；右键某个分组里
 * 的目录时带上目录本身和这一组，勾的还是这一组在目录下的改动。
 */
export const COMMIT_SCOPE_PARAM = "scope"

export type CommitScope = "tracked" | "untracked"

/**
 * `paths` 编码后最多这么长（#528）。网页版的提交窗口是浏览器按地址加载的，
 * 门户前面的反向代理默认请求行约 8KB，超了直接回 414；留出地址其余部分的余量。
 */
export const COMMIT_PATHS_MAX_ENCODED_LENGTH = 6000

function encodeCommitPaths(paths: readonly string[] | null | undefined) {
  const list = (paths ?? []).filter((path) => path.length > 0)
  return list.length === 0 ? null : encodeURIComponent(JSON.stringify(list))
}

/** 这些路径编进地址会不会太长（超过 COMMIT_PATHS_MAX_ENCODED_LENGTH）。 */
export function commitPathsTooLong(
  paths: readonly string[] | null | undefined
): boolean {
  const encoded = encodeCommitPaths(paths)
  return encoded !== null && encoded.length > COMMIT_PATHS_MAX_ENCODED_LENGTH
}

/** 把路径和范围拼到窗口地址后面；都没有时原样返回。 */
export function appendCommitPathsParam(
  route: string,
  paths: readonly string[] | null | undefined,
  scope?: CommitScope | null
): string {
  const params: string[] = []
  const encoded = encodeCommitPaths(paths)
  if (encoded !== null) params.push(`${COMMIT_PATHS_PARAM}=${encoded}`)
  if (scope) params.push(`${COMMIT_SCOPE_PARAM}=${scope}`)
  if (params.length === 0) return route
  const sep = route.includes("?") ? "&" : "?"
  return `${route}${sep}${params.join("&")}`
}

/** 读回 `scope`；只认 tracked、untracked，别的都当没带。 */
export function parseCommitScopeParam(raw: string | null): CommitScope | null {
  return raw === "tracked" || raw === "untracked" ? raw : null
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
