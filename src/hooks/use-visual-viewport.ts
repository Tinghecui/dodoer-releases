"use client"

import { useSyncExternalStore } from "react"

import { kbdLiftPx } from "@/lib/terminal/keybar"

/**
 * 全局可见区域（visualViewport）跟踪。
 *
 * 手机上软键盘弹起时，布局视口（window.innerHeight）不变、可见视口被压缩，
 * iOS 还会把页面整体往上推（offsetTop > 0）。工作区根容器和终端键栏都要跟着
 * 键盘以上真正可见的那块区域走，这里只算一份、所有订阅方共用：
 *
 * - 有订阅方时监听 visualViewport 的 resize / scroll 和 window resize，
 *   连着来的事件合并到一帧（requestAnimationFrame）里，避免键盘开合时抖；
 * - 可见高度和偏移写进根元素的 CSS 变量 `--app-vvh` / `--app-vv-top`，
 *   工作区根容器用 `var(--app-vvh, 100dvh)` 排版；键盘遮住的像素数写进
 *   `--app-kbd-lift`，给 portal 到 body 的侧边抽屉用；
 * - 最后一个订阅方退订时停止监听并删掉变量，桌面布局完全不受影响。
 */

/** 可见高度，比如 `544px`。没有变量时消费方退回 `100dvh`。 */
export const VV_HEIGHT_VAR = "--app-vvh"
/** 可见区域相对布局视口顶部的偏移，比如 `120px`。 */
export const VV_OFFSET_TOP_VAR = "--app-vv-top"
/**
 * 布局视口底部被键盘遮住的像素数（即 keyboardLift），比如 `300px`。
 * 挂在根容器外面（portal 到 body）的侧边抽屉用它把底边抬到键盘以上。
 */
export const VV_KEYBOARD_LIFT_VAR = "--app-kbd-lift"

/** 可见高度比窗口高度少这么多，才算键盘弹起（和 kbdLiftPx 的阈值一致）。 */
export const KEYBOARD_OPEN_MIN_PX = 80

export interface VisualViewportState {
  /** 可见高度；没有在跟踪（或浏览器没有 visualViewport）时为 null。 */
  height: number | null
  offsetTop: number
  /** 底部被键盘遮住的像素数，算法即终端原来的 kbdLiftPx。 */
  keyboardLift: number
  /** 可见高度明显小于窗口高度。 */
  keyboardOpen: boolean
}

const IDLE: VisualViewportState = {
  height: null,
  offsetTop: 0,
  keyboardLift: 0,
  keyboardOpen: false,
}

let snapshot: VisualViewportState = IDLE
const listeners = new Set<() => void>()
let detach: (() => void) | null = null

function measure(vv: VisualViewport): VisualViewportState {
  const innerHeight = window.innerHeight
  const height = Math.round(vv.height)
  const offsetTop = Math.max(0, Math.round(vv.offsetTop))
  return {
    height,
    offsetTop,
    keyboardLift: kbdLiftPx(innerHeight, vv.height, vv.offsetTop),
    keyboardOpen: innerHeight - vv.height >= KEYBOARD_OPEN_MIN_PX,
  }
}

function sameState(a: VisualViewportState, b: VisualViewportState) {
  return (
    a.height === b.height &&
    a.offsetTop === b.offsetTop &&
    a.keyboardLift === b.keyboardLift &&
    a.keyboardOpen === b.keyboardOpen
  )
}

function writeCssVars(state: VisualViewportState) {
  const style = document.documentElement.style
  if (state.height === null) {
    style.removeProperty(VV_HEIGHT_VAR)
    style.removeProperty(VV_OFFSET_TOP_VAR)
    style.removeProperty(VV_KEYBOARD_LIFT_VAR)
    return
  }
  style.setProperty(VV_HEIGHT_VAR, `${state.height}px`)
  style.setProperty(VV_OFFSET_TOP_VAR, `${state.offsetTop}px`)
  style.setProperty(VV_KEYBOARD_LIFT_VAR, `${state.keyboardLift}px`)
}

function commit(next: VisualViewportState) {
  if (sameState(snapshot, next)) return
  snapshot = next
  writeCssVars(next)
  for (const l of listeners) l()
}

function start() {
  const vv = window.visualViewport
  if (!vv) return
  let raf = 0
  const update = () => {
    raf = 0
    commit(measure(vv))
  }
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update)
  }
  vv.addEventListener("resize", schedule)
  vv.addEventListener("scroll", schedule)
  window.addEventListener("resize", schedule)
  detach = () => {
    if (raf) cancelAnimationFrame(raf)
    vv.removeEventListener("resize", schedule)
    vv.removeEventListener("scroll", schedule)
    window.removeEventListener("resize", schedule)
  }
  // 首次同步量一次，订阅方第一帧就拿到真实高度。
  commit(measure(vv))
}

function stop() {
  detach?.()
  detach = null
  snapshot = IDLE
  writeCssVars(IDLE)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

const noopSubscribe = () => () => {}
const getSnapshot = () => snapshot
const getIdle = () => IDLE

/**
 * 订阅全局可见区域。`enabled` 为 false 时不监听、不写变量，返回空闲状态；
 * 只在手机布局下传 true。
 */
export function useVisualViewport(enabled: boolean): VisualViewportState {
  return useSyncExternalStore(
    enabled ? subscribe : noopSubscribe,
    enabled ? getSnapshot : getIdle,
    getIdle
  )
}
