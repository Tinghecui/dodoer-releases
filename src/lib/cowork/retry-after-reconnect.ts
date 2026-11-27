/**
 * Cowork 加的（#1323）：连接失败过，用户在排队区点「重试」。
 *
 * 这时直接清掉失败标记没用：连接还是出错，排队区那条「智能体不可用就把队首标成
 * 失败」的 effect 会马上又标回去。所以先记下用户要重试哪条（「全部重试」记
 * `"all"`），由调用方重新连接；连接错误一清掉（重连开始了，不必等就绪）就替
 * 用户清掉失败标记、交给排队区的自动发送，由它去等连接就绪（它有等待超时兜
 * 底）。重连途中出现什么中间状态都不会把这次重试丢掉（#1640）；重连又失败了，
 * 那条 effect 会把它重新标成失败、带重试。智能体其实没装的，就忘掉这次，消息
 * 照旧标着失败、带重试，不会以后哪次装上了自己发出去。
 */
export type RetryAfterReconnectTarget = string | "all"

export function createRetryAfterReconnect() {
  let target: RetryAfterReconnectTarget | null = null
  return {
    /** 用户点了重试：记下要重试的那条，「全部重试」盖过单条。 */
    note(next: RetryAfterReconnectTarget): void {
      if (target !== "all") target = next
    },
    /**
     * 连接状态变了调一次。返回这一刻要重试的（只返回一次），没有就是 null。
     * 点下去那一刻还是「连接失败」的，接着等。
     */
    observe({
      unavailable,
    }: {
      unavailable: "not_installed" | "connect_failed" | null
    }): RetryAfterReconnectTarget | null {
      if (target == null) return null
      if (unavailable == null) {
        const t = target
        target = null
        return t
      }
      if (unavailable === "not_installed") target = null
      return null
    },
  }
}
