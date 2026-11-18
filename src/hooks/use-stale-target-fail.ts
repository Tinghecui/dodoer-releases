import { useEffect, useRef } from "react"

import { STALE_TARGET_FAIL_MS } from "@/lib/queue-flush"

/**
 * Cowork fork（#792）：连接一直「已连上、但连的是别的目录 / 智能体」，排队区
 * 又有没失败的消息时，从进入这种状态起计时，满 STALE_TARGET_FAIL_MS 调一次
 * onTimeout（再请求连接、把队首标失败）。
 *
 * 计时只跟「是不是停在旧目标」「排队区空不空」「队首失败没」这三件事走：
 * 等待期间用户又排了几条、或者回调换了引用，都不会把计时清零重来，
 * 不然一直往里加消息，队首就永远等不到失败和重试。
 */
export function useStaleTargetFail({
  stale,
  queueLength,
  headFailed,
  isReady,
  onTimeout,
}: {
  stale: boolean
  /** 排队区有几条；只用来判断空不空，条数变了不重新计时。 */
  queueLength: number
  headFailed: boolean
  /** 到点时再看一眼：已经就绪了就什么都不做。 */
  isReady: () => boolean
  onTimeout: () => void
}): void {
  const isReadyRef = useRef(isReady)
  const onTimeoutRef = useRef(onTimeout)
  useEffect(() => {
    isReadyRef.current = isReady
    onTimeoutRef.current = onTimeout
  })

  const armed = stale && queueLength > 0 && !headFailed
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => {
      if (isReadyRef.current()) return
      onTimeoutRef.current()
    }, STALE_TARGET_FAIL_MS)
    return () => clearTimeout(timer)
  }, [armed])
}
