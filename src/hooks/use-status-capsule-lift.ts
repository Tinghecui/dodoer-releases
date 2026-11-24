"use client"

import { useEffect, useState, type RefObject } from "react"

/**
 * 侧栏收起时，窗口左下（和右下）角浮着一条状态胶囊（StatusCapsules，带
 * `data-status-capsule`）。底部的输入框和它横向重叠、又落在同一条底边带里时，
 * 要往上让开多少像素：胶囊高度再加 8px 的缝。不重叠返回 0。
 *
 * `content` 是要让开的那块内容（输入框本体）的位置，`bandBottom` 是它所在的
 * 底部容器的下沿：胶囊下沿在这条下沿往上 64px 以内、胶囊顶又在这条下沿之上，
 * 才算同一条带。
 */
export function statusCapsuleLift(
  content: DOMRect | null | undefined,
  bandBottom: number
): number {
  if (!content || content.width <= 0) return 0
  let lift = 0
  for (const capsule of document.querySelectorAll<HTMLElement>(
    "[data-status-capsule]"
  )) {
    const r = capsule.getBoundingClientRect()
    const overlapsX = r.left < content.right && r.right > content.left
    // 胶囊顶也要在容器下沿之上：底部终端打开时容器被抬高，胶囊整个落在
    // 容器下面，不会压住内容
    const sameBand = r.bottom > bandBottom - 64 && r.top < bandBottom
    if (overlapsX && sameBand) {
      lift = Math.max(lift, r.height + 8)
    }
  }
  return lift
}

/**
 * 盯着底部容器 `ref`，返回它的第一个子元素（输入框本体）要为状态胶囊让开的
 * 像素数。容器大小变了（侧栏开合会改变它的宽度，胶囊也跟着出现、消失）、
 * 窗口大小变了都重新算。容器的祖先也一起盯着：打开、关闭底部终端时容器
 * 尺寸不变、只是整体挪了位置，变的是它所在那一栏的高度。
 */
export function useStatusCapsuleLift(
  ref: RefObject<HTMLElement | null>
): number {
  const [lift, setLift] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const update = () => {
      frame = 0
      const content = (el.firstElementChild ?? el).getBoundingClientRect()
      setLift(statusCapsuleLift(content, el.getBoundingClientRect().bottom))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule)
    // 容器本身和它往上到 body 的每一层祖先：位置变了总有一层的尺寸变了
    for (let node: Element | null = el; node; node = node.parentElement) {
      observer?.observe(node)
      if (node === document.body) break
    }
    window.addEventListener("resize", schedule)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [ref])
  return lift
}
