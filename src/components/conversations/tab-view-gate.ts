import type { ConversationKind } from "@/lib/types"

/** 主区给一个会话标签挂什么：`wait` 先不挂（等会话列表），`loop` 挂 Loop
 *  视图，`chat` 挂普通会话视图。 */
export type TabViewKind = "wait" | "loop" | "chat"

/** jenny fork: a Loop row has no agent to connect to. Until the first list
 *  comes back a restored tab can't tell, so it mounts nothing yet. */
export function tabViewKind(opts: {
  conversationId: number | null | undefined
  conversationsLoaded: boolean
  kind: ConversationKind | undefined
  /** 这个标签在本页当过草稿、已经挂着普通会话视图（比如草稿标签发消息时
   *  刚建好会话）。 */
  mountedBefore: boolean
}): TabViewKind {
  const { conversationId, conversationsLoaded, kind, mountedBefore } = opts
  // #1045：只拦还没挂过视图的（刷新后恢复的）。挂过的再卸掉，排队区那条
  // 重挂时读回成失败，不再自动发送。
  if (conversationId != null && !conversationsLoaded && !mountedBefore) {
    return "wait"
  }
  return kind === "loop" ? "loop" : "chat"
}

/** #1045：把 `tabs` 里还没有会话号的（草稿）标签加进 `seen`。这些标签一开始
 *  就挂着普通会话视图，后来绑上会话号也不该再等会话列表。没有新的就原样
 *  返回 `seen`。 */
export function collectDraftTabIds(
  tabs: readonly { id: string; conversationId?: number | null }[],
  seen: ReadonlySet<string>
): ReadonlySet<string> {
  const fresh = tabs.filter(
    (tab) => tab.conversationId == null && !seen.has(tab.id)
  )
  if (fresh.length === 0) return seen
  return new Set([...seen, ...fresh.map((tab) => tab.id)])
}
