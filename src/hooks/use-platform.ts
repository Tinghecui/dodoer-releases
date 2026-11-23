"use client"

import { useEffect, useState } from "react"

export type PlatformType = "macos" | "ios" | "windows" | "linux" | "unknown"

export function detectPlatform(): PlatformType {
  if (typeof navigator === "undefined") return "unknown"

  const platform = navigator.platform.toLowerCase()
  const userAgent = navigator.userAgent.toLowerCase()

  // iPhone、iPad 的 UA 里有 "like Mac OS X"，要先认出来，不能当成 Mac。
  // iPadOS 的桌面模式报的是 "Macintosh"，靠多点触控和真 Mac 区分。
  if (/iphone|ipad|ipod/.test(platform) || /iphone|ipad|ipod/.test(userAgent)) {
    return "ios"
  }
  const isMacLike = platform.includes("mac") || userAgent.includes("mac os")
  if (isMacLike && (navigator.maxTouchPoints ?? 0) > 1) {
    return "ios"
  }

  if (isMacLike) {
    return "macos"
  }

  if (platform.includes("win") || userAgent.includes("windows")) {
    return "windows"
  }

  if (
    platform.includes("linux") ||
    userAgent.includes("linux") ||
    userAgent.includes("x11")
  ) {
    return "linux"
  }

  return "unknown"
}

export function usePlatform() {
  const [platform, setPlatform] = useState<PlatformType>("unknown")

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setPlatform(detectPlatform())
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [])

  return {
    platform,
    isMac: platform === "macos",
    isIos: platform === "ios",
    isWindows: platform === "windows",
    isLinux: platform === "linux",
  }
}
