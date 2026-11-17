import type { AgentType } from "@/lib/types"

export interface DraftAgentSettledInput {
  /** 标签页的 `agentTypeProvisional`：智能体还是冷启动猜的。 */
  provisional: boolean | undefined
  /** 标签页（tab store）里的 agentType。 */
  tabAgent: AgentType
  /** 面板本地的 draftAgentType，比标签页晚一次渲染跟上。 */
  selectedAgent: AgentType
  /** 防抖以后真正拿去连接的智能体。 */
  connectAgent: AgentType
}

/**
 * Cowork fork（AI QA #436）：草稿标签页的智能体定下来没有，定下来才自动连接。
 *
 * 冷启动时草稿的智能体是猜的（provisional），列表回来以后 TabProvider 的纠正
 * 才把它改成真正的默认值。不等的话，自动连接会先用猜的那个（新员工是 Codex）
 * 起进程，员工没有它的凭据，首屏就弹「Codex 无法建立会话」。纠正改完以后，
 * 面板的本地状态晚一次渲染、连接用的值再晚 300ms 防抖才跟上，这两段里连出去的
 * 也还是旧的智能体，所以三者一致才算定下来。
 */
export function draftAgentSettled({
  provisional,
  tabAgent,
  selectedAgent,
  connectAgent,
}: DraftAgentSettledInput): boolean {
  return (
    !provisional && tabAgent === selectedAgent && connectAgent === selectedAgent
  )
}
