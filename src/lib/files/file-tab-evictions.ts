// 文件标签上限（MAX_FILE_TABS）关掉了哪些标签：工作区关之前记下路径，持久化看到
// 标签少了的时候来问「这个是上限关的吗」，分清上限挤掉的和用户自己关的。靠数恢复
// 刚加了几个来推断分不准：同一次渲染里上限挤掉的是别的项目的（看不到），用户恰好
// 又关了一个，用户关的那个会被当成挤掉的。
//
// 一个文档一份，只记路径。问过一次就划掉；同一个路径又开出来，说明上次的那次关
// 已经过去了，也划掉（见 clearFileTabEvictionMarks）。

const evictedByCap = new Set<string>()

/** 工作区按上限关标签之前调：这几个路径是上限关的。 */
export function markFileTabsEvictedByCap(paths: Iterable<string>): void {
  for (const path of paths) evictedByCap.add(path)
}

/** 这些路径眼下又开着：上次上限关它们的记号不再算数。 */
export function clearFileTabEvictionMarks(openPaths: Iterable<string>): void {
  if (evictedByCap.size === 0) return
  for (const path of openPaths) evictedByCap.delete(path)
}

/** 这个路径是不是上限关掉的；问过就划掉，同一次关只认一次。 */
export function takeFileTabEvictedByCap(path: string): boolean {
  return evictedByCap.delete(path)
}

/** 仅测试用。 */
export function resetFileTabEvictionsForTests(): void {
  evictedByCap.clear()
}
