import { extractAppCommandError, isFetchNetworkError } from "@/lib/app-error"

/**
 * Cowork fork (#984): 发消息的请求没等到回应，不知道服务器收没收到。
 *
 * - 桌面端远程窗口：`remote_proxy.rs` 的 `call_api` 请求发出去以后超时、连接断了
 *   （「Remote HTTP request failed」），或者回应读到一半坏了（「Failed to parse
 *   remote response」）。远端明确回了状态码的（4xx/5xx）不算，那是服务器拒绝了。
 * - 网页：`web-transport` 等超时抛的「Request timed out」，和 fetch 根本没拿到回应。
 *
 * 这几种情况下服务器可能已经收下并开始跑这一轮了（#984：回复照常出来了，
 * 排队区却留着一条「发送失败」）。
 */
export function isUncertainSendError(error: unknown): boolean {
  if (isFetchNetworkError(error)) return true
  if (error instanceof Error && error.message === "Request timed out") {
    return true
  }
  const appError = extractAppCommandError(error)
  return (
    appError?.code === "network_error" &&
    (appError.message === "Remote HTTP request failed" ||
      appError.message === "Failed to parse remote response")
  )
}

/** 记住的服务器回传 id 最多几条：只用来对上刚发出去的那几条消息。 */
const MAX_ECHOES = 50

/**
 * Cowork fork (#984): 对「没确认送达」的消息和服务器回传的同一条用户消息。
 *
 * 服务器收下消息后会广播 `user_message`，id 就是发送时带的 clientMessageId
 * （乐观显示那条的 id）。发送方自己也收得到这条回传：
 * - 请求失败之前已经回传过：服务器收下了，不当失败处理（`echoed` 为 true）。
 * - 失败以后才回传：`noteEcho` 交回 `noteUncertain` 记下的那份副本信息
 *   （排队 id 和放回去的草稿），调用方把没被用户改过的副本从排队区拿掉。
 * 一直没回传的就一直留着，带重试和删除（宁可留副本，也不丢消息）。
 */
export interface UncertainSendWatch<Copy> {
  /** 收到服务器回传的用户消息 id；有对应的失败副本时交回记下的副本信息。 */
  noteEcho: (messageId: string) => Copy | null
  /** 这个 id 服务器回传过没有。 */
  echoed: (messageId: string) => boolean
  /** 记下没确认送达、放回排队区的那一条：发送时的 id 和它的副本信息。 */
  noteUncertain: (messageId: string, copy: Copy) => void
}

export function createUncertainSendWatch<Copy>(): UncertainSendWatch<Copy> {
  const echoes: string[] = []
  const pending = new Map<string, Copy>()
  return {
    noteEcho(messageId) {
      if (!echoes.includes(messageId)) {
        echoes.push(messageId)
        if (echoes.length > MAX_ECHOES) echoes.shift()
      }
      const copy = pending.get(messageId) ?? null
      pending.delete(messageId)
      return copy
    },
    echoed(messageId) {
      return echoes.includes(messageId)
    },
    noteUncertain(messageId, copy) {
      pending.set(messageId, copy)
    },
  }
}
