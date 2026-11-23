import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// #1353（跟进 #1319）：会话面板里留言的真实接线。面板太大，整个渲染要替换的
// 依赖太多，这里和同目录别的面板测试一样按源码查接线：
// - 顶栏 actions 里放的是当前标签的「留言」入口；
// - 留言栏「交给我的智能体」接的是实时反馈重发用的那个入队函数；
// - 那个入队函数不看会话在不在跑，空闲和在跑都只是进排队区（排队区自己决定
//   什么时候发），不会走只在「已连接」时才发的直接发送、把留言丢掉。
const source = readFileSync(
  resolve(
    process.cwd(),
    "src/components/conversations/conversation-detail-panel.tsx"
  ),
  "utf8"
)

/** 从 `start` 开始截出一段源码，到第一个 `end` 为止（含）。 */
function sliceFrom(start: string, end: string): string {
  const i = source.indexOf(start)
  expect(i, `missing: ${start}`).toBeGreaterThanOrEqual(0)
  const j = source.indexOf(end, i + start.length)
  expect(j, `missing end after: ${start}`).toBeGreaterThan(i)
  return source.slice(i, j + end.length)
}

describe("conversation detail panel: session comments wiring", () => {
  it("the header actions carry the Comments entry for the active tab", () => {
    const actions = sliceFrom("actions={", "</>")
    expect(actions).toMatch(
      /<SessionCommentsButton\s+conversationId=\{activeTab\.conversationId\}\s*\/>/
    )
  })

  it("Give to my agent goes to the same enqueue as the live-feedback resend", () => {
    const panel = sliceFrom("<OwnSessionComments", "/>")
    expect(panel).toMatch(/conversationId=\{dbConversationId\}/)
    expect(panel).toMatch(/isActive=\{isActive\}/)
    expect(panel).toMatch(/onForward=\{resendFeedbackAsPrompt\}/)
    expect(source).toMatch(/onResendAsPrompt:\s*resendFeedbackAsPrompt/)
  })

  it("the enqueue only queues, the same whether the session is idle or running", () => {
    const body = sliceFrom(
      "const resendFeedbackAsPrompt = useCallback(",
      "[mqEnqueue, selectedModeId]"
    )
    expect(body).toMatch(
      /mqEnqueue\(\s*\{\s*blocks:\s*\[\{\s*type:\s*"text",\s*text\s*\}\],\s*displayText:\s*text\s*\},\s*selectedModeId\s*\)/
    )
    // 不按连接状态分路，也不直接发送。
    expect(body).not.toMatch(/connStatus|handleSend|sendPrompt/)
  })
})
