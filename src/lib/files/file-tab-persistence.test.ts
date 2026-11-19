import { beforeEach, describe, expect, it, vi } from "vitest"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"

// 连的是哪个服务器：null 是本机，数字是桌面端连着的远程服务器
const transport = vi.hoisted(() => ({ remoteId: null as number | null }))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => transport.remoteId,
}))

import {
  fileTabsStorageKey,
  forgetPersistedFileTabPaths,
  hasRegroupedFileTabs,
  markRegroupedFileTabs,
  readPersistedFileTabs,
  readSharedFileTabs,
  regroupPersistedFileTabs,
  samePersistedFileTabs,
  sharedFileTabsStorageKey,
  snapshotFileTabs,
  writePersistedFileTabs,
  writeSharedFileTabs,
} from "./file-tab-persistence"

function tab(
  id: string,
  kind: FileWorkspaceTab["kind"],
  path: string | null
): FileWorkspaceTab {
  return {
    id,
    kind,
    folderId: null,
    title: id,
    description: null,
    path,
    language: kind === "browser" ? "browser" : "plaintext",
    content: "",
    loading: false,
    ...(kind === "browser"
      ? {
          browser: {
            initialUrl: "https://example.com/",
            openerTabId: null,
            profile: "default",
          },
        }
      : {}),
  } as FileWorkspaceTab
}

describe("file-tab-persistence", () => {
  beforeEach(() => {
    localStorage.clear()
    transport.remoteId = null
  })

  it("共用的那一排单独一条：没记过是 null，记了空的读回空的，划掉别的项目的标签时不动它", () => {
    expect(sharedFileTabsStorageKey()).toBe(
      "workspace:file-tabs:v1:local:shared"
    )
    expect(readSharedFileTabs()).toBeNull()
    writeSharedFileTabs({ paths: ["/r/a.ts", "/s/b.ts"], active: "/s/b.ts" })
    forgetPersistedFileTabPaths(["/r/a.ts"], "local", 1)
    expect(readSharedFileTabs()).toEqual({
      paths: ["/r/a.ts", "/s/b.ts"],
      active: "/s/b.ts",
      owners: new Map(),
    })
    writeSharedFileTabs({ paths: [], active: null })
    expect(readSharedFileTabs()).toEqual({
      paths: [],
      active: null,
      owners: new Map(),
    })
    transport.remoteId = 5
    expect(readSharedFileTabs()).toBeNull()
  })

  it("共用的那一排记下每个文件在哪些项目里开着（可以几个），按项目的记录不带它", () => {
    writeSharedFileTabs(
      { paths: ["/r/a.ts", "/s/b.ts", "/t/c.ts"], active: "/r/a.ts" },
      "local",
      new Map([
        ["/r/a.ts", [1, 2]],
        ["/s/b.ts", [2]],
      ])
    )
    expect(readSharedFileTabs("local")).toEqual({
      paths: ["/r/a.ts", "/s/b.ts", "/t/c.ts"],
      active: "/r/a.ts",
      owners: new Map([
        ["/r/a.ts", [1, 2]],
        ["/s/b.ts", [2]],
      ]),
    })
    writePersistedFileTabs(1, { paths: ["/r/a.ts"], active: null }, "local")
    expect(readPersistedFileTabs(1, "local")).toEqual({
      paths: ["/r/a.ts"],
      active: null,
    })
  })

  it("存了再读回来，顺序和选中项不变", () => {
    writePersistedFileTabs(3, {
      paths: ["/r/b.ts", "/r/a.ts"],
      active: "/r/a.ts",
    })
    expect(readPersistedFileTabs(3)).toEqual({
      paths: ["/r/b.ts", "/r/a.ts"],
      active: "/r/a.ts",
    })
  })

  it("按项目分开存", () => {
    writePersistedFileTabs(1, { paths: ["/one/x.ts"], active: null })
    writePersistedFileTabs(2, { paths: ["/two/y.ts"], active: "/two/y.ts" })
    expect(readPersistedFileTabs(1).paths).toEqual(["/one/x.ts"])
    expect(readPersistedFileTabs(2).paths).toEqual(["/two/y.ts"])
    expect(fileTabsStorageKey(1)).toBe("workspace:file-tabs:v1:local:1")
  })

  it("按服务器分开存：连不同服务器时同一个项目编号互不覆盖", () => {
    writePersistedFileTabs(1, { paths: ["/local/a.ts"], active: null })
    transport.remoteId = 5
    expect(readPersistedFileTabs(1)).toEqual({ paths: [], active: null })
    writePersistedFileTabs(1, {
      paths: ["/remote/b.ts"],
      active: "/remote/b.ts",
    })
    expect(fileTabsStorageKey(1)).toBe("workspace:file-tabs:v1:remote-5:1")
    expect(readPersistedFileTabs(1).paths).toEqual(["/remote/b.ts"])
    transport.remoteId = 6
    expect(readPersistedFileTabs(1).paths).toEqual([])
    transport.remoteId = null
    expect(readPersistedFileTabs(1).paths).toEqual(["/local/a.ts"])
  })

  it("空的标签栏把记录删掉", () => {
    writePersistedFileTabs(1, { paths: ["/r/a.ts"], active: null })
    writePersistedFileTabs(1, { paths: [], active: null })
    expect(localStorage.getItem(fileTabsStorageKey(1))).toBeNull()
  })

  it("坏数据和旧版本当成没有", () => {
    const key = fileTabsStorageKey(1)
    localStorage.setItem(key, "{not json")
    expect(readPersistedFileTabs(1)).toEqual({ paths: [], active: null })
    localStorage.setItem(
      key,
      JSON.stringify({ version: 0, tabs: [{ kind: "file", path: "/r/a" }] })
    )
    expect(readPersistedFileTabs(1)).toEqual({ paths: [], active: null })
    localStorage.setItem(key, JSON.stringify(null))
    expect(readPersistedFileTabs(1)).toEqual({ paths: [], active: null })
  })

  it("单条坏的只丢那一条，选中项不在列表里就不选", () => {
    localStorage.setItem(
      fileTabsStorageKey(1),
      JSON.stringify({
        version: 1,
        tabs: [
          { kind: "file", path: "/r/a.ts" },
          null,
          { kind: "diff", path: "/r/b.ts" },
          { kind: "file", path: 3 },
          { kind: "file", path: "/r/a.ts" },
          { kind: "file", path: "/r/c.ts" },
        ],
        active: "/r/b.ts",
      })
    )
    expect(readPersistedFileTabs(1)).toEqual({
      paths: ["/r/a.ts", "/r/c.ts"],
      active: null,
    })
  })

  it("快照只取文件标签，选中的不是文件标签时 active 为 null", () => {
    const tabs = [
      tab("f1", "file", "/r/a.ts"),
      tab("d1", "diff", "/r/a.ts"),
      tab("b1", "browser", null),
      tab("f2", "file", "/r/b.ts"),
    ]
    expect(snapshotFileTabs(tabs, "f2")).toEqual({
      paths: ["/r/a.ts", "/r/b.ts"],
      active: "/r/b.ts",
    })
    expect(snapshotFileTabs(tabs, "b1").active).toBeNull()
    expect(
      samePersistedFileTabs(snapshotFileTabs(tabs, "f2"), {
        paths: ["/r/a.ts", "/r/b.ts"],
        active: "/r/b.ts",
      })
    ).toBe(true)
    expect(
      samePersistedFileTabs(snapshotFileTabs(tabs, "f1"), {
        paths: ["/r/a.ts", "/r/b.ts"],
        active: "/r/b.ts",
      })
    ).toBe(false)
  })

  it("从同一个服务器上别的项目的记录里划掉关掉的路径，自己的和别的服务器的不动", () => {
    localStorage.clear()
    writePersistedFileTabs(
      1,
      { paths: ["/r/a.ts", "/r/b.ts"], active: "/r/a.ts" },
      "local"
    )
    writePersistedFileTabs(
      2,
      { paths: ["/r/a.ts"], active: "/r/a.ts" },
      "local"
    )
    writePersistedFileTabs(
      3,
      { paths: ["/r/a.ts"], active: "/r/a.ts" },
      "local"
    )
    writePersistedFileTabs(
      1,
      { paths: ["/r/a.ts"], active: "/r/a.ts" },
      "remote-9"
    )

    const rewritten = forgetPersistedFileTabPaths(["/r/a.ts"], "local", 3)

    // 返回改写过的项目和改写后的记录，调用方拿去更新自己的缓存
    expect([...rewritten].sort((x, y) => x.folderId - y.folderId)).toEqual([
      { folderId: 1, entries: { paths: ["/r/b.ts"], active: null } },
      { folderId: 2, entries: { paths: [], active: null } },
    ])
    expect(readPersistedFileTabs(1, "local")).toEqual({
      paths: ["/r/b.ts"],
      active: null,
    })
    expect(readPersistedFileTabs(2, "local")).toEqual({
      paths: [],
      active: null,
    })
    expect(localStorage.getItem(fileTabsStorageKey(2, "local"))).toBeNull()
    expect(readPersistedFileTabs(3, "local").paths).toEqual(["/r/a.ts"])
    expect(readPersistedFileTabs(1, "remote-9").paths).toEqual(["/r/a.ts"])
  })
})

describe("regroupPersistedFileTabs", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  const folders = [
    { id: 1, path: "/a" },
    { id: 2, path: "/b" },
  ]

  it("别的项目目录下的文件挪到那个项目的记录末尾，选中的被挪走就不留选中项（#740）", () => {
    writePersistedFileTabs(
      1,
      { paths: ["/a/x.ts", "/b/y.ts", "/tmp/z.md"], active: "/b/y.ts" },
      "local"
    )
    writePersistedFileTabs(
      2,
      { paths: ["/a/x.ts", "/b/w.ts"], active: "/b/w.ts" },
      "local"
    )
    // 别的服务器的记录不动
    writePersistedFileTabs(1, { paths: ["/b/y.ts"], active: null }, "remote-9")
    const rewritten = regroupPersistedFileTabs("local", folders)
    expect(rewritten.map((entry) => entry.folderId).sort()).toEqual([1, 2])
    expect(readPersistedFileTabs(1, "local")).toEqual({
      paths: ["/a/x.ts", "/tmp/z.md"],
      active: null,
    })
    expect(readPersistedFileTabs(2, "local")).toEqual({
      paths: ["/b/w.ts", "/b/y.ts"],
      active: "/b/w.ts",
    })
    expect(readPersistedFileTabs(1, "remote-9").paths).toEqual(["/b/y.ts"])
  })

  it("只记在别的项目里的文件也不丢：它自己的项目没有记录就新建一条", () => {
    writePersistedFileTabs(1, { paths: ["/b/y.ts"], active: null }, "local")
    regroupPersistedFileTabs("local", folders)
    expect(localStorage.getItem(fileTabsStorageKey(1, "local"))).toBeNull()
    expect(readPersistedFileTabs(2, "local").paths).toEqual(["/b/y.ts"])
  })

  it("按目录归属：不管文件是什么时候记进来的，别的项目目录下的都挪走", () => {
    writePersistedFileTabs(
      1,
      { paths: ["/a/x.ts", "/b/kept.ts"], active: "/b/kept.ts" },
      "local"
    )
    regroupPersistedFileTabs("local", folders)
    expect(readPersistedFileTabs(1, "local")).toEqual({
      paths: ["/a/x.ts"],
      active: null,
    })
    expect(readPersistedFileTabs(2, "local").paths).toEqual(["/b/kept.ts"])
  })

  it("归位过的标记按服务器分开记", () => {
    expect(hasRegroupedFileTabs("local")).toBe(false)
    markRegroupedFileTabs("local")
    expect(hasRegroupedFileTabs("local")).toBe(true)
    expect(hasRegroupedFileTabs("remote-9")).toBe(false)
  })
})
