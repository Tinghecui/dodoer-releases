import { useEffect, useState } from "react"

import { STALE_TARGET_FAIL_MS } from "@/lib/queue-flush"

/**
 * Cowork fork（#1006）：排队的消息一直在等连接起来（智能体还在启动、握手），
 * 从开始等算起，满 STALE_TARGET_FAIL_MS 后返回已经等了几秒（每秒更新），
 * 没等满或不在等时返回 null。
 *
 * 只用来给排队区换提示、给「重新连接」按钮：到点不把队首标失败——
 * 连接可能马上就好，标失败容易让用户重发（定了的做法）。
 * 不在等了（连上、队首失败、排队区清空）就清零，下次重新计时。
 */
export function useSlowConnectWait(waiting: boolean): number | null {
  // 已经等了几秒；只在计时器回调里更新。不在等了就在渲染时清零
  // （React 推荐的「随 props 调整 state」写法），下次重新计时。
  const [seconds, setSeconds] = useState(0)
  const [wasWaiting, setWasWaiting] = useState(waiting)
  if (wasWaiting !== waiting) {
    setWasWaiting(waiting)
    setSeconds(0)
  }

  useEffect(() => {
    if (!waiting) return
    const start = Date.now()
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [waiting])

  if (!waiting || seconds * 1000 < STALE_TARGET_FAIL_MS) return null
  return seconds
}
