"use client"

// CoTeam「让我的智能体接着做」（#1235 第 7 行）的交接：只读视图里点了按钮，
// 在我自己的工作环境里开一个新草稿，把一句预填的话交给那个草稿的输入框。
//
// 和「就选中内容提问」（`ask-selection-handoff.ts`）同一种交接方式：按标签页
// 存在模块里（新草稿可能还没挂上，挂上时自己来取），再发一个事件给已经挂着
// 的草稿（每个分组复用一个草稿，可能早就挂着）。不同的是这句话放进**输入框**，
// 不进排队区、不发送：用户补完自己点发送。
//
// 取的时候也要对上打开时说好的项目和智能体：复用别的项目、别的智能体的草稿时
// 改挂是异步的，没改完之前取走，话就落在旧项目的输入框里。

import { useEffect, useRef } from "react"
import type { AgentType } from "@/lib/types"

export const CONTINUE_PROMPT_PARKED_EVENT = "codeg:cowork-continue-parked"

export interface ContinuePromptParkedDetail {
  tabId: string
}

export interface ParkedContinuePrompt {
  /** 要放进输入框的那句话。 */
  prompt: string
  /** 打开草稿时 store 说好的智能体和项目（见 `OpenedDraftTarget`）。 */
  agentType: AgentType
  folderId: number
}

export interface ContinueDrainState {
  agentType: AgentType
  folderId: number
}

/** 预填的话里写的会话引用：`登录名/会话号`，cowork-context team-read 认这个。 */
export function continueSessionRef(owner: string, id: string): string {
  return `${owner}/${id}`
}

const parked = new Map<string, ParkedContinuePrompt>()

/**
 * 给 `tabId` 存一句预填的话，草稿已经挂着就通知它来取。同一个草稿只留最后
 * 一句：连点两次（或先后点两个同事的会话）只要最后那次的，不叠两句。
 */
export function parkContinuePrompt(
  tabId: string,
  entry: ParkedContinuePrompt
): void {
  parked.set(tabId, entry)
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<ContinuePromptParkedDetail>(CONTINUE_PROMPT_PARKED_EVENT, {
      detail: { tabId },
    })
  )
}

/** 取走给 `tabId` 存的、和它现在的项目和智能体对得上的那句话；没有就是 null。 */
export function consumeContinuePrompt(
  tabId: string,
  state: ContinueDrainState
): string | null {
  const entry = parked.get(tabId)
  if (!entry) return null
  if (entry.agentType !== state.agentType || entry.folderId !== state.folderId)
    return null
  parked.delete(tabId)
  return entry.prompt
}

/** 测试用：清掉还存着的。 */
export function resetContinuePromptsForTests(): void {
  parked.clear()
}

/**
 * 会话面板这一头：挂上时、收到通知时、项目或智能体变了（改挂落地）时来取，
 * 取到就交给 `onPrompt`（面板把它放进输入框）。
 */
export function useContinuePromptDrain(
  tabId: string,
  state: ContinueDrainState,
  onPrompt: (prompt: string) => void
): void {
  const onPromptRef = useRef(onPrompt)
  useEffect(() => {
    onPromptRef.current = onPrompt
  }, [onPrompt])
  const { agentType, folderId } = state
  useEffect(() => {
    const drain = () => {
      const prompt = consumeContinuePrompt(tabId, { agentType, folderId })
      if (prompt !== null) onPromptRef.current(prompt)
    }
    drain()
    const onParked = (event: Event) => {
      const detail = (event as CustomEvent<ContinuePromptParkedDetail>).detail
      if (detail?.tabId !== tabId) return
      drain()
    }
    window.addEventListener(CONTINUE_PROMPT_PARKED_EVENT, onParked)
    return () =>
      window.removeEventListener(CONTINUE_PROMPT_PARKED_EVENT, onParked)
  }, [agentType, folderId, tabId])
}
