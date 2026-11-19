import { isDesktop } from "./transport"

/**
 * 合并工具（/merge）和工作区里的「合并冲突」弹窗之间的事件。
 *
 * 桌面版两个都是 Tauri 窗口，用 Tauri 的 emit/listen；网页版没有 Tauri，
 * 合并工具是同源的另一个浏览器标签页，改用 BroadcastChannel 传。
 * 以前网页版里 emit 什么都不发，工作区的弹窗收不到「合并完成」，一直不关（#894）。
 */
export const MERGE_EVENTS_CHANNEL = "codeg-merge-events"

export type MergeEventName =
  | "folder://merge-conflict-resolved"
  | "folder://merge-completed"
  | "folder://merge-aborted"

interface MergeEventMessage {
  event: MergeEventName
  payload: unknown
}

function openChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null
  try {
    return new BroadcastChannel(MERGE_EVENTS_CHANNEL)
  } catch {
    return null
  }
}

export async function emitMergeEvent(
  event: MergeEventName,
  payload: unknown
): Promise<void> {
  if (isDesktop()) {
    try {
      const { emit } = await import("@tauri-apps/api/event")
      await emit(event, payload)
    } catch {
      /* Tauri 发不出去就算了，和以前一样 */
    }
    return
  }
  const channel = openChannel()
  if (!channel) return
  try {
    const message: MergeEventMessage = { event, payload }
    channel.postMessage(message)
  } finally {
    channel.close()
  }
}

/**
 * 监听网页版合并工具标签页发来的事件。桌面版的事件仍走 subscribe()，
 * 这里只管 BroadcastChannel；桌面版没人往这个 channel 发，不会重复。
 */
export function listenMergeEvents(
  handler: (event: MergeEventName, payload: unknown) => void
): () => void {
  const channel = openChannel()
  if (!channel) return () => {}
  channel.onmessage = (e: MessageEvent) => {
    const data = e.data as Partial<MergeEventMessage> | null
    if (!data || typeof data.event !== "string") return
    handler(data.event as MergeEventName, data.payload)
  }
  return () => {
    channel.onmessage = null
    channel.close()
  }
}
