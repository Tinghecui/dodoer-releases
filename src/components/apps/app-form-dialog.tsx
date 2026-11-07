"use client"

import { useId, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"
import { useImeGuard } from "@/hooks/use-ime-guard"
import type { WorkbenchApp, WorkbenchAppLaunch } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  APP_COMMAND_MAX,
  APP_DIR_MAX,
  APP_NAME_MAX,
  APP_URL_MAX,
  validateAppForm,
  type AppFormError,
  type AppFormValues,
} from "@/lib/workbench-apps"

/**
 * Add or edit an app: name, address, how it starts, and the command that
 * serves it. One dialog for both — `app` null is "new". Mounted fresh on
 * every open (Radix unmounts closed content), so it starts from the app as it
 * is now, never from an abandoned edit.
 */
export function AppFormDialog({
  open,
  onOpenChange,
  app,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  app: WorkbenchApp | null
  /** Resolves to whether the save succeeded; the dialog closes only then. */
  onSubmit: (values: AppFormValues) => Promise<boolean>
}) {
  const t = useTranslations("Apps.form")
  const nameRef = useRef<HTMLInputElement>(null)
  // While a save is out the dialog must not be dismissed, or a save that then
  // fails would take what was typed with it.
  const pendingRef = useRef(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pendingRef.current) return
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="sm:max-w-[32rem]"
        data-app-form=""
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          nameRef.current?.focus()
          nameRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>{app ? t("editTitle") : t("newTitle")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <AppForm
          app={app}
          nameRef={nameRef}
          pendingRef={pendingRef}
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function AppForm({
  app,
  nameRef,
  pendingRef,
  onCancel,
  onSubmit,
  onDone,
}: {
  app: WorkbenchApp | null
  nameRef: React.RefObject<HTMLInputElement | null>
  /** Set while a save is out — a ref as well as state, because Enter and the
   *  button can both fire before the re-render that disables the button. */
  pendingRef: React.RefObject<boolean>
  onCancel: () => void
  onSubmit: (values: AppFormValues) => Promise<boolean>
  onDone: () => void
}) {
  const t = useTranslations("Apps.form")
  const nameId = useId()
  const urlId = useId()
  const commandId = useId()
  const dirId = useId()
  const ime = useImeGuard()
  const [values, setValues] = useState<AppFormValues>({
    name: app?.name ?? "",
    url: app?.url ?? "",
    startCommand: app?.startCommand ?? "",
    workingDir: app?.workingDir ?? "",
    launch: app?.launch ?? "auto",
  })
  const [error, setError] = useState<AppFormError | null>(null)
  const [pending, setPending] = useState(false)
  const set = (patch: Partial<AppFormValues>) => {
    setValues((prev) => ({ ...prev, ...patch }))
    setError(null)
  }
  const hasCommand = values.startCommand.trim() !== ""

  const submit = async () => {
    if (pendingRef.current) return
    const problem = validateAppForm(values)
    if (problem) {
      setError(problem)
      return
    }
    pendingRef.current = true
    setPending(true)
    const ok = await onSubmit(values)
    pendingRef.current = false
    setPending(false)
    if (ok) onDone()
  }

  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (ime.isComposing(e)) return
    if (e.key === "Enter") {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nameId}>{t("name")}</Label>
          <Input
            id={nameId}
            ref={nameRef}
            name="app-name"
            value={values.name}
            maxLength={APP_NAME_MAX}
            placeholder={t("namePlaceholder")}
            aria-invalid={error === "nameRequired" || undefined}
            onChange={(e) => set({ name: e.target.value })}
            {...ime.props}
            onKeyDown={onEnter}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={urlId}>{t("url")}</Label>
          <Input
            id={urlId}
            name="app-url"
            value={values.url}
            maxLength={APP_URL_MAX}
            placeholder="http://127.0.0.1:7500/"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={
              error === "urlRequired" || error === "urlInvalid" || undefined
            }
            onChange={(e) => set({ url: e.target.value })}
            {...ime.props}
            onKeyDown={onEnter}
          />
          <p className="text-xs text-muted-foreground">{t("urlHint")}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={commandId}>{t("startCommand")}</Label>
          <Textarea
            id={commandId}
            name="app-start-command"
            value={values.startCommand}
            rows={2}
            maxLength={APP_COMMAND_MAX}
            placeholder={t("startCommandPlaceholder")}
            spellCheck={false}
            className="max-h-32 resize-none font-mono text-xs"
            onChange={(e) => set({ startCommand: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            {t("startCommandHint")}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={dirId}>{t("workingDir")}</Label>
          <Input
            id={dirId}
            name="app-working-dir"
            value={values.workingDir}
            maxLength={APP_DIR_MAX}
            placeholder="~/Documents/my-app"
            spellCheck={false}
            autoComplete="off"
            disabled={!hasCommand}
            className="font-mono text-xs"
            onChange={(e) => set({ workingDir: e.target.value })}
            {...ime.props}
            onKeyDown={onEnter}
          />
          <p className="text-xs text-muted-foreground">{t("workingDirHint")}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium leading-none">
            {t("launch")}
          </span>
          <RadioGroup
            value={values.launch}
            onValueChange={(value) =>
              set({ launch: value as WorkbenchAppLaunch })
            }
            className="grid-cols-2"
            disabled={!hasCommand}
            aria-label={t("launch")}
          >
            {(["auto", "manual"] as const).map((launch) => (
              <label
                key={launch}
                className={cn(
                  "flex items-start gap-2 rounded-md border p-2.5 text-xs",
                  hasCommand
                    ? "cursor-pointer"
                    : "cursor-not-allowed opacity-60",
                  values.launch === launch
                    ? "border-primary bg-primary/5"
                    : "border-input"
                )}
              >
                <RadioGroupItem
                  value={launch}
                  className="mt-0.5"
                  data-app-launch={launch}
                />
                <span>
                  <span className="block font-medium text-foreground">
                    {launch === "auto" ? t("launchAuto") : t("launchManual")}
                  </span>
                  <span className="mt-0.5 block text-muted-foreground">
                    {launch === "auto"
                      ? t("launchAutoHint")
                      : t("launchManualHint")}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
          {!hasCommand ? (
            <p className="text-xs text-muted-foreground">
              {t("launchNeedsCommand")}
            </p>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {t(`errors.${error}`)}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={pending}
        >
          {t("cancel")}
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("save")}
        </Button>
      </DialogFooter>
    </>
  )
}
