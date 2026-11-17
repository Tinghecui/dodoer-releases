/**
 * Cowork 加的（#423）：智能体不认这个会话了（后端的 `session_lost`：底下的 CLI
 * 被杀了、适配器还活着，这一轮根本没开始），这条消息自动再发一次。
 *
 * 失败的那一轮照常把消息放回排队区、标成失败；等旧连接退到不再是 `error` /
 * `prompting`（后端发完 Error 马上发 Disconnected），再走一次和点「重试」一样的路：
 * 清掉失败标记、重新连接、由排队区发出去。新连接用 session/load 接回原来的会话。
 * 每条消息只自动重试一次，同一条再失败就留给用户点重试，不会一直重发。
 *
 * 按草稿对象认消息：放回排队区、重试、再发出去，用的都是同一个草稿对象。
 */
export function createSessionLostRetry() {
  const retried = new WeakSet<object>()
  let pending: object | null = null
  return {
    /** 这一轮以 `session_lost` 结束。返回这条消息还能不能自动重发（第一次才能）。 */
    noteFailed(draft: object): boolean {
      if (retried.has(draft)) return false
      pending = draft
      return true
    },
    /**
     * 现在要不要自动重试排队区的队首：是等着自动重发的那条、还标着失败，旧连接
     * 也已经不在出错或运行中。返回 true 时算用掉了这一次。
     */
    takeReady(
      head: { draft: object; failed?: boolean } | undefined,
      connStatus: string | null | undefined
    ): boolean {
      if (pending == null || head == null || head.draft !== pending) {
        return false
      }
      if (!head.failed) return false
      if (connStatus === "error" || connStatus === "prompting") return false
      retried.add(pending)
      pending = null
      return true
    },
  }
}

/**
 * 自动重发这一刻怎么走（审查打回 #499）。`retry`：当前标签，和点「重试」一样
 * （重连只管当前标签）。`background`：用户已经切到别的会话，自己清掉失败标记、
 * 在后台重连，排队区连上以后照常发出去。`wait`：后台标签自己连不了（智能体不可用、
 * 还没准备好连接），先不用掉这一次，等用户切回来再走 `retry`。
 */
export function sessionLostRetryRoute({
  isActive,
  canConnect,
}: {
  isActive: boolean
  canConnect: boolean
}): "retry" | "background" | "wait" {
  if (isActive) return "retry"
  return canConnect ? "background" : "wait"
}
