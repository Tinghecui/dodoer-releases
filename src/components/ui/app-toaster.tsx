"use client"

import { useEffect, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { useTheme } from "next-themes"
import { Toaster, toast, useSonner, type ToasterProps } from "sonner"

import { useIsMobile } from "@/hooks/use-mobile"
import {
  acquireNativeSurfaceOcclusion,
  subscribeNativeSurfaceReclaim,
} from "@/lib/browser/native-surface-occlusion"

/** Client-only gate that survives hydration: `false` on the server AND on the
 *  hydration pass, `true` on the first render after it — so the portal below
 *  never makes the two disagree. */
const subscribeNever = () => () => {}
const onClient = () => true
const onServer = () => false

/**
 * Longest a run of toasts may keep a page down.
 *
 * Every toast this app raises goes away on its own well inside it (the
 * workspace's own are the longest at 15 s), so this is not a reading budget —
 * it is the stop on a toast that never leaves: one raised with an infinite
 * duration, or one whose dismissal was lost. The page comes back; the toast
 * stays, hidden behind it, as it was before any of this.
 */
const MAX_HOLD_MS = 20_000

/**
 * While a toast is on screen, hold the native browser surfaces down.
 *
 * A child webview paints above every DOM element of the window (see
 * `native-surface-occlusion`), so a toast raised while a browser tab is open
 * is not "behind" the page in any way a z-index could fix — it is simply not
 * on screen. The lease is a PASSIVE one: the hosts leave the page's last frame
 * in place, keep the keyboard where it was, refuse to blank a pane that has no
 * frame to leave, and give the page straight back when the user reaches for it
 * — which is what the reclaim below answers, by taking the toasts away.
 *
 * Costs nothing where there is no surface to hold down (every other window,
 * and the workspace whenever no browser tab is showing): the store has no
 * subscribers and the lease is a counter bump.
 */
function ToastOcclusion() {
  const { toasts } = useSonner()
  const showing = toasts.length > 0

  useEffect(() => {
    if (!showing) return
    // One lease and one timer per RUN of toasts, not per toast: the effect
    // only re-runs when the screen goes empty, so toasts arriving back to
    // back hold the page down once instead of flickering it in between.
    const release = acquireNativeSurfaceOcclusion("toast", { passive: true })
    const timer = window.setTimeout(release, MAX_HOLD_MS)
    const unsubscribe = subscribeNativeSurfaceReclaim(() => toast.dismiss())
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
      release()
    }
  }, [showing])

  return null
}

/**
 * 手机布局下提示条的位置：顶部居中，每一边让出对应的安全区（刘海、横屏时
 * 两侧的圆角）。右下角在手机上正好压着输入框和发送按钮，底部还有横条。
 * sonner 窄屏（600px 以下）用 mobileOffset，横屏的手机比它宽，用 offset，
 * 两个都给。
 */
const MOBILE_TOAST_OFFSET = {
  top: "max(1rem, env(safe-area-inset-top))",
  right: "max(1rem, env(safe-area-inset-right))",
  bottom: "max(1rem, env(safe-area-inset-bottom))",
  left: "max(1rem, env(safe-area-inset-left))",
}

/**
 * Cowork（#1393）：每个弹窗的标题都限三行。直接调 sonner 的地方会把
 * err.message 原样当标题，那可能是几十行日志；不限的话弹窗比屏幕还高，
 * 关闭按钮跑到屏幕外。sonner 会把这里的 class 和每个弹窗自己的合在一起。
 */
const TITLE_CLAMP_CLASS = "line-clamp-3 break-words"

function withTitleClamp(
  options: ToasterProps["toastOptions"]
): ToasterProps["toastOptions"] {
  const own = options?.classNames?.title
  return {
    ...options,
    classNames: {
      ...options?.classNames,
      title: own ? `${own} ${TITLE_CLAMP_CLASS}` : TITLE_CLAMP_CLASS,
    },
  }
}

export function AppToaster(props: ToasterProps) {
  const isMobile = useIsMobile()
  const { resolvedTheme } = useTheme()
  const theme = props.theme ?? (resolvedTheme === "dark" ? "dark" : "light")
  const mounted = useSyncExternalStore(subscribeNever, onClient, onServer)

  if (!mounted) return null
  // Portalled to the body, because sonner's z-index is only worth what its
  // stacking context is: the workspace shell's root is `fixed inset-0`, which
  // establishes one, and every dialog portals to the body at z-50 — so a toast
  // raised while a dialog is open (the error that explains why the button did
  // nothing) painted UNDER it. In the body the toaster sits in the root
  // stacking context, above every overlay, wherever it is mounted from.
  return createPortal(
    <>
      <Toaster
        {...props}
        {...(isMobile && {
          position: "top-center",
          offset: MOBILE_TOAST_OFFSET,
          mobileOffset: MOBILE_TOAST_OFFSET,
        })}
        theme={theme}
        toastOptions={withTitleClamp(props.toastOptions)}
      />
      {/* Its own component so the toast list it watches re-renders nothing
          but itself. */}
      <ToastOcclusion />
    </>,
    document.body
  )
}
