import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

// jsdom 没有布局，这几条锁住手机上整屏高度和抽屉留白用的类名。
const root = resolve(process.cwd(), "src")
const layout = readFileSync(join(root, "app/workspace/layout.tsx"), "utf8")

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsxFiles(path)
    return path.endsWith(".tsx") && !/\.test\.tsx$/.test(path) ? [path] : []
  })
}

describe("手机上整屏页面不超出屏幕", () => {
  it("src 下非测试的 tsx 不再按屏幕算整屏高度", () => {
    const hits = tsxFiles(root).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${relative(root, path)}:${i + 1}` }))
        .filter(({ line }) => /\b(min-)?h-screen\b/.test(line))
        .map(({ at }) => at)
    )
    expect(hits).toEqual([])
  })

  it("终端抽屉的高度按动态视口算", () => {
    expect(layout).not.toMatch(/h-\[95vh\]/)
    expect(layout).toMatch(/className="h-\[95dvh\] p-0"/)
  })

  it("会话列表和右侧面板两个抽屉都带上安全区边距", () => {
    expect(layout.match(/SIDE_DRAWER_SAFE_AREA_CLASS\s*\)/g)).toHaveLength(2)
  })
})
