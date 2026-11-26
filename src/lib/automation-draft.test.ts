import { beforeEach, describe, expect, it } from "vitest"

import {
  clearAutomationDraft,
  listAutomationDraftIds,
  loadAutomationDraft,
  saveAutomationDraft,
  type AutomationEditorDraft,
} from "./automation-draft"

const DRAFT: AutomationEditorDraft = {
  name: "Sample job",
  action: "launch_session",
  agentType: "claude_code",
  userChoseAgent: false,
  prompt: "do the thing",
  folderId: 1,
  isolation: "worktree_per_run",
  trigger: "manual",
  cron: "0 9 * * 1-5",
  modeId: null,
  configValues: {},
  branch: "",
  isRemoteBranch: false,
}

beforeEach(() => localStorage.clear())

describe("automation-draft（#1564）", () => {
  it("存了能读回来，清掉就没了", () => {
    saveAutomationDraft({ kind: "edit", id: 3 }, DRAFT)
    expect(loadAutomationDraft({ kind: "edit", id: 3 })).toEqual(DRAFT)
    clearAutomationDraft({ kind: "edit", id: 3 })
    expect(loadAutomationDraft({ kind: "edit", id: 3 })).toBeNull()
  })

  it("不同自动化、新建各存各的，互不干扰", () => {
    saveAutomationDraft({ kind: "edit", id: 3 }, { ...DRAFT, name: "a" })
    saveAutomationDraft({ kind: "edit", id: 4 }, { ...DRAFT, name: "b" })
    saveAutomationDraft({ kind: "create" }, { ...DRAFT, name: "c" })
    clearAutomationDraft({ kind: "edit", id: 3 })
    expect(loadAutomationDraft({ kind: "edit", id: 3 })).toBeNull()
    expect(loadAutomationDraft({ kind: "edit", id: 4 })?.name).toBe("b")
    expect(loadAutomationDraft({ kind: "create" })?.name).toBe("c")
    expect(listAutomationDraftIds()).toEqual([4])
  })

  it("坏掉的草稿当没有，并删掉", () => {
    localStorage.setItem("workspace:automation-draft:edit-5", "{not json")
    expect(loadAutomationDraft({ kind: "edit", id: 5 })).toBeNull()
    localStorage.setItem(
      "workspace:automation-draft:edit-6",
      JSON.stringify({ draft: { name: 1 } })
    )
    expect(loadAutomationDraft({ kind: "edit", id: 6 })).toBeNull()
    expect(localStorage.getItem("workspace:automation-draft:edit-6")).toBeNull()
  })
})
