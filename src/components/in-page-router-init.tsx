"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { setInPageRouter } from "@/lib/in-page-navigation"

/**
 * 把 Next 的路由交给 `lib/in-page-navigation`：手机布局下设置、提交这些页面
 * 用它在当前页里打开、返回（#1332），`lib/api.ts` 里拿不到 `useRouter`。
 */
export function InPageRouterInit() {
  const router = useRouter()
  useEffect(
    () =>
      setInPageRouter({
        push: (path) => router.push(path),
        back: () => router.back(),
      }),
    [router]
  )
  return null
}
