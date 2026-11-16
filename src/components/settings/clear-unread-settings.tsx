"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { MailCheck } from "lucide-react"
import { toast } from "sonner"

import { SettingsSection } from "@/components/shared/settings-section"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { markAllConversationsAccepted } from "@/stores/conversation-seen-store"

export function ClearUnreadSettingsSection() {
  const t = useTranslations("ClearUnreadSettings")
  const [confirming, setConfirming] = useState(false)

  const clearAll = () => {
    markAllConversationsAccepted()
    setConfirming(false)
    toast.success(t("cleared"))
  }

  return (
    <SettingsSection
      icon={MailCheck}
      title={t("title")}
      description={t("description")}
      control={
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirming(true)}
          >
            {t("button")}
          </Button>
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("confirmDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={clearAll}>
                  {t("confirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      }
    />
  )
}
