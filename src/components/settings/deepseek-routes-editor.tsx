"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, Plus, Info, Loader2, Save } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { loadDeepSeekRoutes, updateDeepSeekRoutes } from "@/lib/api"
import type { DeepSeekRoutes } from "@/lib/types"

/**
 * A starting point for one extra route: an OpenAI Responses compatible
 * gateway. The key is NOT in it — the route names an environment variable,
 * which the user sets in the env box above (the backend refuses `apiKey`).
 */
export const DEEPSEEK_ROUTES_EXAMPLE = `providers:
  my-gateway:
    displayName: My gateway
    api: openai-responses
    baseURL: https://gateway.example.com/v1
    apiKeyEnv: MY_GATEWAY_API_KEY
    models:
      - id: model-a
        name: Model A
        contextWindow: 200000
`

/**
 * Whether the draft is worth a save. An imported section counts even when the
 * text is unchanged: saving it is what copies it into the agent's own document,
 * so a later upgrade that drops the import cannot lose it.
 */
export function canSaveDeepSeekRoutes(
  routes: DeepSeekRoutes | null,
  draft: string,
  saving: boolean
): boolean {
  if (!routes || routes.error || saving) return false
  return draft !== routes.yaml || !!routes.importedFrom
}

/**
 * Editor for the DeepSeek agent's extra model routes (pi-ai's `llm-pi-ai`
 * section). Plain YAML: the route schema is pi-ai's and wide, and pi-ai
 * reports what it refuses when the session starts.
 */
export function DeepSeekRoutesEditor() {
  const t = useTranslations("DeepSeekRoutesEditor")
  const [routes, setRoutes] = useState<DeepSeekRoutes | null>(null)
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Re-read after a write and show what landed: the backend re-renders the
  // section, so the text on screen would otherwise differ from the document.
  const refresh = useCallback(async () => {
    const next = await loadDeepSeekRoutes()
    setRoutes(next)
    setDraft(next.yaml)
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    void loadDeepSeekRoutes()
      .then((next) => {
        if (!alive) return
        setRoutes(next)
        setDraft(next.yaml)
      })
      .catch((error) => {
        console.error("[DeepSeek] load routes failed", error)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const canSave = canSaveDeepSeekRoutes(routes, draft, saving)

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await updateDeepSeekRoutes(draft)
      await refresh()
      toast.success(t("toastSaved"))
    } catch (error) {
      console.error("[DeepSeek] save routes failed", error)
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t("toastSaveFailed")
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div className="min-w-0">
        <label className="text-xs font-medium" htmlFor="deepseek-routes-yaml">
          {t("title")}
        </label>
        <p className="mt-1 text-2xs text-muted-foreground">
          {t("description")}
        </p>
      </div>

      {loading ? (
        <p className="flex items-center gap-1.5 py-2 text-2xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("loading")}
        </p>
      ) : !routes ? (
        <p className="rounded-md border border-dashed px-3 py-3 text-center text-2xs text-muted-foreground">
          {t("loadFailed")}
        </p>
      ) : routes.error ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-2xs text-amber-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 space-y-1">
            <p>{t("unreadable")}</p>
            <p className="break-all font-mono opacity-80">{routes.error}</p>
            <p className="break-all font-mono opacity-80">{routes.path}</p>
          </div>
        </div>
      ) : (
        <>
          {routes.importedFrom && (
            <p className="flex items-start gap-1.5 text-2xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {t("importedHint")}{" "}
                <span className="break-all font-mono opacity-80">
                  {routes.importedFrom}
                </span>
              </span>
            </p>
          )}

          <Textarea
            id="deepseek-routes-yaml"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            // The save re-reads the document into the box; text typed while it
            // is in flight would be overwritten.
            readOnly={saving}
            placeholder={t("placeholder")}
            spellCheck={false}
            className="min-h-40 rounded-md font-mono text-xs md:text-xs"
          />

          <ul className="list-disc space-y-0.5 pl-4 text-2xs text-muted-foreground">
            <li>{t("hintKey")}</li>
            <li>{t("hintModels")}</li>
            <li>{t("hintNewSessions")}</li>
          </ul>

          <p className="break-all text-2xs text-muted-foreground">
            {t("fileHint")}{" "}
            <span className="font-mono opacity-80">{routes.path}</span>
          </p>

          <div className="flex justify-end gap-2">
            {!draft.trim() && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setDraft(DEEPSEEK_ROUTES_EXAMPLE)}
                disabled={saving}
                className="gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("insertExample")}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSave()}
              disabled={!canSave}
              className="gap-1.5"
            >
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                <>
                  <Save className="h-3.5 w-3.5" />
                  {t("save")}
                </>
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
