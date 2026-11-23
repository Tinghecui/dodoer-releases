"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { DesktopOnlyPage } from "@/components/layout/desktop-only-notice"
import { useHideDesktopOnly } from "@/hooks/use-hide-desktop-only"
import { PetWindow } from "./_components/PetWindow"

function PetPageInner() {
  const t = useTranslations("Pet")
  const params = useSearchParams()
  const petId = params.get("petId")
  // 宠物是桌面上的浮动小窗，手机上不做（#1335）
  const hideDesktopOnly = useHideDesktopOnly()

  if (hideDesktopOnly) return <DesktopOnlyPage />

  if (!petId) {
    return (
      <div
        className="flex h-dvh w-screen items-center justify-center text-xs text-muted-foreground"
        style={{ background: "transparent" }}
      >
        {t("missingPetIdParam")}
      </div>
    )
  }

  return <PetWindow petId={petId} />
}

export default function PetPage() {
  return (
    <Suspense fallback={null}>
      <PetPageInner />
    </Suspense>
  )
}
