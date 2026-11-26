"use client"

import type {
  AgentType,
  AutomationAction,
  AutomationIsolation,
  AutomationTriggerKind,
} from "@/lib/types"

// 自动化编辑器里改了还没保存的内容，存在浏览器里。刷新、切到别的页面再回来，
// 点这一项还能回到编辑器接着改，不悄悄丢掉（#1564）。

const KEY_PREFIX = "workspace:automation-draft:"

/** 编辑器表单的一份快照：编辑器各个输入框当时的值。 */
export interface AutomationEditorDraft {
  name: string
  action: AutomationAction
  agentType: AgentType
  /** 用户自己选过智能体没有；没选过的话恢复时用自动化原来的智能体。 */
  userChoseAgent: boolean
  prompt: string
  folderId: number | null
  isolation: AutomationIsolation
  trigger: AutomationTriggerKind
  cron: string
  modeId: string | null
  configValues: Record<string, string>
  branch: string
  isRemoteBranch: boolean
}

/** 草稿归谁：编辑某个已有的自动化，或者新建。 */
export type AutomationDraftTarget =
  | { kind: "edit"; id: number }
  | { kind: "create" }

interface StoredDraft {
  draft: AutomationEditorDraft
  saved_at: string
}

function keyOf(target: AutomationDraftTarget): string {
  return KEY_PREFIX + (target.kind === "edit" ? `edit-${target.id}` : "create")
}

function isDraft(value: unknown): value is AutomationEditorDraft {
  if (!value || typeof value !== "object") return false
  const d = value as Record<string, unknown>
  return (
    typeof d.name === "string" &&
    typeof d.action === "string" &&
    typeof d.agentType === "string" &&
    typeof d.prompt === "string" &&
    (d.folderId === null || typeof d.folderId === "number") &&
    typeof d.isolation === "string" &&
    typeof d.trigger === "string" &&
    typeof d.cron === "string" &&
    (d.modeId === null || typeof d.modeId === "string") &&
    !!d.configValues &&
    typeof d.configValues === "object" &&
    typeof d.branch === "string" &&
    typeof d.isRemoteBranch === "boolean"
  )
}

/**
 * 读草稿；坏掉的（不是这个格式的）顺手删掉。
 *
 * 不按自动化的 updated_at 作废：开关启用也会改 updated_at，按它作废会在用户
 * 不知道的时候把草稿扔掉。草稿一直留到保存、取消、确认放弃或这一项被删掉。
 */
export function loadAutomationDraft(
  target: AutomationDraftTarget
): AutomationEditorDraft | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(keyOf(target))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredDraft> | null
    if (!parsed || !isDraft(parsed.draft)) {
      localStorage.removeItem(keyOf(target))
      return null
    }
    return {
      ...parsed.draft,
      userChoseAgent: parsed.draft.userChoseAgent === true,
    }
  } catch {
    return null
  }
}

export function saveAutomationDraft(
  target: AutomationDraftTarget,
  draft: AutomationEditorDraft
): void {
  if (typeof window === "undefined") return
  const stored: StoredDraft = {
    draft,
    saved_at: new Date().toISOString(),
  }
  try {
    localStorage.setItem(keyOf(target), JSON.stringify(stored))
  } catch {
    /* 存不下就算了，页面开着时草稿还在内存里 */
  }
}

export function clearAutomationDraft(target: AutomationDraftTarget): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(keyOf(target))
  } catch {
    /* ignore */
  }
}

/** 存着草稿的已有自动化的 id（列表上给它们标「编辑中」用）。 */
export function listAutomationDraftIds(): number[] {
  if (typeof window === "undefined") return []
  const ids: number[] = []
  try {
    const prefix = KEY_PREFIX + "edit-"
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(prefix)) continue
      const id = Number(key.slice(prefix.length))
      if (Number.isInteger(id)) ids.push(id)
    }
  } catch {
    /* ignore */
  }
  return ids
}
