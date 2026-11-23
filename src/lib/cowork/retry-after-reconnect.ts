/**
 * Cowork 加的（#1323）：连接失败过，用户在排队区点「重试」。
 *
 * 这时直接清掉失败标记没用：连接还是出错，排队区那条「智能体不可用就把队首标成
 * 失败」的 effect 会马上又标回去。所以先记下用户要重试哪条（「全部重试」记
 * `"all"`），由调用方重新连接；等连接就绪了再替用户清掉失败标记、交给排队区的
 * 自动发送。重连也失败了（中间出现过不是「不可用」的状态、又回到不可用），或者
 * 智能体其实没装，就忘掉这次，消息照旧标着失败、带重试，不会以后哪次连上了
 * 自己发出去。
 */
export type RetryAfterReconnectTarget = string | "all"

export function createRetryAfterReconnect() {
  let target: RetryAfterReconnectTarget | null = null
  // 记下以后有没有见过「不是不可用」（正在连接）的状态：见过以后再变回不可用，
  // 才算这次重连失败；点下去那一刻还是「连接失败」不算。
  let attempted = false
  const clear = () => {
    target = null
    attempted = false
  }
  return {
    /** 用户点了重试：记下要重试的那条，「全部重试」盖过单条。 */
    note(next: RetryAfterReconnectTarget): void {
      if (target !== "all") target = next
      attempted = false
    },
    /**
     * 连接状态变了调一次。返回这一刻要重试的（只返回一次），没有就是 null。
     */
    observe({
      ready,
      unavailable,
    }: {
      ready: boolean
      unavailable: "not_installed" | "connect_failed" | null
    }): RetryAfterReconnectTarget | null {
      if (target == null) return null
      if (ready && unavailable == null) {
        const t = target
        clear()
        return t
      }
      if (unavailable == null) {
        attempted = true
        return null
      }
      if (unavailable === "not_installed" || attempted) clear()
      return null
    },
  }
}
