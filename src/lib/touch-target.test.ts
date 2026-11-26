import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { compile } from "tailwindcss"
import { describe, expect, it } from "vitest"

import {
  COARSE_BOX_32,
  COARSE_HIT_32,
  COARSE_HIT_40,
  COARSE_VISIBLE_BOX_24,
  HOVER_NONE_REVEAL,
  TOUCH_GAP_0_5,
  TOUCH_GAP_1,
  TOUCH_ROOM_BOTTOM_0,
  TOUCH_ROOM_TOP_0,
} from "./touch-target"

// 类名检查：这些文件里每一处「悬停才出现」（`group-hover…:opacity-100`）的写法，
// 同一个 className 里都要带上不能悬停时的兜底，不然手机上这个按钮等于不存在。
// 组件太重、不方便渲染的（消息列表、git log、标签页）靠这个兜住。
const HOVER_REVEAL_FILES = [
  // 自己消息上的复制和「建任务」
  "src/components/message/message-list-view.tsx",
  // 未激活文件标签的关闭按钮（文件标签栏），和会话标签的关闭按钮
  "src/components/files/file-workspace-tab-bar.tsx",
  "src/components/tabs/tab-item.tsx",
  // git log 里的行内按钮（作者历史的删除、提交号的复制）
  "src/components/layout/aux-panel-git-log-tab.tsx",
  // git log 提交说明的复制按钮
  "src/components/layout/git-log-commit-message.tsx",
  // 工具调用行的展开箭头
  "src/components/message/activity/activity-row.tsx",
  // 图片的下载按钮
  "src/components/message/user-image-attachments.tsx",
  "src/components/message/generated-images-block.tsx",
]

const HOVER_REVEAL = /group-hover(?:\/[\w-]+)?:opacity-100/g
const FALLBACK = /HOVER_NONE_REVEAL|\[@media\(hover:none\)\]:opacity-/

/** 从匹配处往后取一段，够盖住同一个 className 表达式的剩下部分。 */
function classExpressionAfter(source: string, index: number): string {
  return source.slice(index, index + 400)
}

describe("hover-only buttons have a touch fallback", () => {
  it.each(HOVER_REVEAL_FILES)("%s", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8")
    const hits = [...source.matchAll(HOVER_REVEAL)]
    expect(hits.length).toBeGreaterThan(0)
    const missing = hits
      .filter((m) => !FALLBACK.test(classExpressionAfter(source, m.index)))
      .map((m) => source.slice(0, m.index).split("\n").length)
    expect(missing, `${file} 第 ${missing.join("、")} 行没有触屏兜底`).toEqual(
      []
    )
  })
})

describe("touch-target class sets", () => {
  it("only reveal on hover-less devices", () => {
    for (const cls of HOVER_NONE_REVEAL.split(" ")) {
      expect(cls.startsWith("[@media(hover:none)]:")).toBe(true)
    }
  })

  it("only widen the hit area on coarse pointers", () => {
    for (const cls of [
      ...COARSE_HIT_32.split(" "),
      ...COARSE_HIT_40.split(" "),
    ]) {
      expect(cls.startsWith("pointer-coarse:")).toBe(true)
      // 除了把那一行告诉的间距、上下空地抄给 ::after 的那几个，其余都只改 ::after
      if (cls.startsWith("pointer-coarse:[--touch-hit-")) continue
      expect(cls).toMatch(/:after:/)
    }
  })

  it("only resize the button itself on coarse pointers", () => {
    for (const cls of COARSE_BOX_32.split(" ")) {
      expect(cls.startsWith("pointer-coarse:")).toBe(true)
      expect(cls.startsWith("pointer-coarse:after:")).toBe(false)
    }
    expect(COARSE_BOX_32).toContain("pointer-coarse:min-h-8")
    expect(COARSE_BOX_32).toContain("pointer-coarse:min-w-8")
  })

  it("grows the thumbnail cross itself instead of an invisible area", () => {
    for (const cls of COARSE_VISIBLE_BOX_24.split(" ")) {
      expect(cls.startsWith("pointer-coarse:")).toBe(true)
      expect(cls).not.toMatch(/:after:/)
    }
    expect(COARSE_VISIBLE_BOX_24).toContain("pointer-coarse:size-6")
  })
})

// 小按钮（xs、icon-xs）后面有兄弟元素时，粗指针下的区域不往后伸（见上面
// 「in a real row」）。再加一道保险：后面紧跟的文字（缩放百分比、「第几条」）
// 要是定位元素（`relative`），万一区域伸过来，文字后画、盖住它。这里扫一遍组件源码，找「小按钮 </Button> 后面紧跟 <span」的写法
// （属性里的 `=>` 不算标签结束）。
const SMALL_BUTTON_THEN_SPAN =
  /<Button\b(?:=>|[^>])*?\bsize="(?:xs|icon-xs)"(?:=>|[^>])*>[\s\S]*?<\/Button>\s*<span\b[^>]*?className="([^"]*)"/g

function componentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return componentFiles(path)
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : []
  })
}

describe("text right after a small button stays tappable", () => {
  it("makes the text a positioned element so the hit area stays under it", () => {
    const offenders: string[] = []
    for (const file of componentFiles(join(process.cwd(), "src/components"))) {
      const source = readFileSync(file, "utf8")
      for (const m of source.matchAll(SMALL_BUTTON_THEN_SPAN)) {
        // 只看紧挨着的那一个按钮：匹配里不能再有别的 <Button
        const body = m[0].slice(1)
        if (body.includes("<Button")) continue
        if (!/(^|\s)(relative|absolute)(\s|$)/.test(m[1])) {
          const line = source.slice(0, m.index).split("\n").length
          offenders.push(`${file.slice(process.cwd().length + 1)}:${line}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

// 用仓库里的 Tailwind 把类名真的编成 CSS，再按 CSS 的规则算出每个按钮在
// 粗指针下的点按范围（::after 的矩形），检查排成一行时谁也不盖谁。
// 只认这几组类名用得到的属性：inset、top/left、宽高、margin-inline-start、translate。
type Side = "base" | "prev" | "next"
/** 那一行告诉按钮的：间距、上面和下面能往外扩多少（没说就是 20px，等于不限）。 */
interface RowEnv {
  gap: number
  roomTop: number
  roomBottom: number
}
type Len = (len: number, env: RowEnv) => number
const PROPS = {
  top: "top",
  bottom: "bottom",
  "inset-inline-start": "start",
  "inset-inline-end": "end",
} as const
type Key = (typeof PROPS)[keyof typeof PROPS]
type Decls = Partial<Record<Key, Len>>

/** 把 Tailwind 生成的长度表达式变成「百分比的基准长度 → px」的函数。 */
function lengthFn(value: string): Len {
  const js = value
    .replace(/var\(--spacing\)/g, "4")
    // 那一行告诉按钮的间距和上下的空地，算的时候传进来
    .replace(/var\(--touch-hit-gap,\s*0px\)/g, "env.gap")
    .replace(/var\(--touch-hit-room-top,\s*20px\)/g, "env.roomTop")
    .replace(/var\(--touch-hit-room-bottom,\s*20px\)/g, "env.roomBottom")
    .replace(/min\(/g, "Math.min(")
    .replace(/max\(/g, "Math.max(")
    .replace(/calc\(/g, "(")
    .replace(/(\d+(?:\.\d+)?)px/g, "$1")
    .replace(/(\d+(?:\.\d+)?)%/g, "($1*len/100)")
  return new Function("len", "env", `return ${js}`) as Len
}

async function compiledDecls(classes: string): Promise<Record<Side, Decls>> {
  const compiler = await compile(
    "@theme { --spacing: 0.25rem; }\n@tailwind utilities;",
    {}
  )
  const css = compiler.build(classes.split(" "))
  const decls: Record<Side, Decls> = { base: {}, prev: {}, next: {} }
  // 每个类一块，从行首的 `.` 开始
  for (const block of css.split(/\n(?=\.)/)) {
    if (!block.includes("@media (pointer: coarse)")) continue
    if (!block.includes("&::after")) continue
    const side: Side = block.includes("&:not(:first-child)")
      ? "prev"
      : block.includes("&:not(:last-child)")
        ? "next"
        : "base"
    for (const [, prop, value] of block.matchAll(
      /^\s*([a-z-]+):\s*([^;]+);/gm
    )) {
      if (!(prop in PROPS)) continue
      decls[side][PROPS[prop as keyof typeof PROPS]] = lengthFn(value)
    }
  }
  return decls
}

interface Box {
  x: number
  w: number
  h: number
}
interface Rect {
  left: number
  right: number
  top: number
  bottom: number
}

/** 一行里按顺序排的元素；buttons 标出哪些是带这组类名的按钮。 */
function hitRects(
  decls: Record<Side, Decls>,
  row: Box[],
  buttons: number[],
  // 那一行告诉子元素的间距（没写的行是 0）和上下的空地（没写是 20px）
  touchGap = 0,
  room: Partial<Pick<RowEnv, "roomTop" | "roomBottom">> = {}
): Rect[] {
  const env: RowEnv = { gap: touchGap, roomTop: 20, roomBottom: 20, ...room }
  return buttons.map((i) => {
    const { x, w, h } = row[i]
    // 选择器更具体的（:not(...)）盖过基础的
    const d: Decls = {
      ...decls.base,
      ...(i < row.length - 1 ? decls.next : {}),
      ...(i > 0 ? decls.prev : {}),
    }
    const at = (k: Key, len: number) => d[k]?.(len, env) ?? 0
    return {
      left: x + at("start", w),
      right: x + w - at("end", w),
      // `+ 0` 把 -0 变成 0
      top: at("top", h) + 0,
      bottom: h - at("bottom", h) + 0,
    }
  })
}

/** globals.css 里 `gap-*` 规则告诉直接子元素的间距（px）；没有规则的类是 0。 */
function touchGapFromGlobals(rowClasses: string): number {
  const css = readFileSync("src/app/globals.css", "utf8")
  for (const [, selectors, n] of css.matchAll(
    /:where\(([^)]*)\) > \* \{\s*--touch-gap: calc\(var\(--spacing\) \* ([\d.]+)\);/g
  )) {
    const names = selectors
      .split(",")
      .map((x) => x.trim().slice(1).replace(/\\/g, ""))
    if (rowClasses.split(/\s+/).some((c) => names.includes(c))) {
      return Number(n) * 4
    }
  }
  return 0
}

/** 从 x=0 开始、隔 gap 排一行。 */
function layoutRow(sizes: [number, number][], gap: number): Box[] {
  let x = 0
  return sizes.map(([w, h]) => {
    const box = { x, w, h }
    x += w + gap
    return box
  })
}

describe("coarse-pointer hit areas in a real row", () => {
  it("makes a lone 24px button 40×40 on every side", async () => {
    const decls = await compiledDecls(COARSE_HIT_40)
    const [r] = hitRects(decls, layoutRow([[24, 24]], 0), [0])
    expect(r).toEqual({ left: -8, right: 32, top: -8, bottom: 32 })
  })

  it("leaves a wide xs button as wide as it is, 40px tall", async () => {
    const decls = await compiledDecls(COARSE_HIT_40)
    const [r] = hitRects(decls, layoutRow([[60, 24]], 0), [0])
    expect(r).toEqual({ left: 0, right: 60, top: -8, bottom: 32 })
  })

  // Mermaid 工具栏：缩小、百分比、放大、重置，间隔 2px（TOUCH_GAP_0_5）
  it("splits the 2px gap between zoom buttons without covering the text", async () => {
    const decls = await compiledDecls(COARSE_HIT_40)
    const row = layoutRow(
      [
        [24, 24],
        [36, 16],
        [24, 24],
        [24, 24],
      ],
      2
    )
    const [zoomOut, zoomIn, reset] = hitRects(decls, row, [0, 2, 3], 2)
    // 缩小只伸进它和百分比之间空隙的一半，不碰百分比
    expect(zoomOut.right).toBe(row[0].x + 24 + 1)
    expect(zoomOut.right).toBeLessThanOrEqual(row[1].x)
    // 放大往前也只伸一半，不碰百分比
    expect(zoomIn.left).toBe(row[2].x - 1)
    expect(zoomIn.left).toBeGreaterThanOrEqual(row[1].x + row[1].w)
    // 放大和重置把中间 2px 平分：正好在中线上接上，不重叠、也不留空
    const mid = row[2].x + 24 + 1
    expect(zoomIn.right).toBe(mid)
    expect(reset.left).toBe(mid)
    // 一组两头朝外的那一侧照样扩出去
    expect(zoomOut.left).toBe(-8)
    expect(reset.right).toBe(row[3].x + 24 + 8)
  })

  // 没用 TOUCH_GAP_* 告诉间距的行：挨着的一侧不往外扩，保证不重叠
  it("keeps the facing sides in place when the row does not announce its gap", async () => {
    const decls = await compiledDecls(COARSE_HIT_40)
    const row = layoutRow(
      [
        [24, 24],
        [24, 24],
      ],
      0
    )
    const [a, b] = hitRects(decls, row, [0, 1])
    expect(a.right).toBe(24)
    expect(b.left).toBe(24)
  })

  // 自己消息那一行：建任务、复制、消息气泡，间隔 4px（TOUCH_GAP_1）
  it("splits the gap between task and copy and keeps copy out of the bubble", async () => {
    const decls = await compiledDecls(COARSE_HIT_40)
    const row = layoutRow(
      [
        [24, 24],
        [24, 24],
        [200, 44],
      ],
      4
    )
    const [task, copy] = hitRects(decls, row, [0, 1], 4)
    // 建任务和复制在 4px 空隙的中线上接上
    expect(task.right).toBe(26)
    expect(copy.left).toBe(26)
    // 复制往气泡那边只伸 2px，不进气泡
    expect(copy.right).toBe(row[2].x - 2)
    expect(copy.right).toBeLessThanOrEqual(row[2].x)
    expect(copy.bottom - copy.top).toBe(40)
  })

  // 排队消息：「发送失败」文字、重试、引导，再往后是编辑，间隔 4px（TOUCH_GAP_1）
  it("splits the gaps around the 32px queue buttons without covering neighbours", async () => {
    const decls = await compiledDecls(COARSE_HIT_32)
    const row = layoutRow(
      [
        [40, 12],
        [20, 18],
        [20, 18],
        [14, 14],
      ],
      4
    )
    const [retry, steer] = hitRects(decls, row, [1, 2], 4)
    expect(retry.left).toBe(row[1].x - 2)
    expect(retry.left).toBeGreaterThanOrEqual(row[0].x + row[0].w)
    expect(retry.right).toBe(row[1].x + 20 + 2)
    expect(steer.left).toBe(retry.right)
    expect(steer.right).toBe(row[3].x - 2)
    expect(steer.bottom - steer.top).toBe(32)
    const [lone] = hitRects(decls, layoutRow([[16, 16]], 0), [0])
    expect(lone).toEqual({ left: -8, right: 24, top: -8, bottom: 24 })
  })
})

// 没用 TOUCH_GAP_* 的行：靠 globals.css 里 `gap-*` 的规则告诉间距
describe("rows laid out with gap-* share the gap without declaring it", () => {
  it("maps every listed gap class to the same --touch-gap", () => {
    for (const [cls, px] of [
      ["gap-0.5", 2],
      ["gap-1", 4],
      ["gap-1.5", 6],
      ["gap-2", 8],
      ["gap-x-1", 4],
      ["gap-x-3", 12],
    ] as const) {
      expect(touchGapFromGlobals(`flex items-center ${cls}`), cls).toBe(px)
    }
    expect(touchGapFromGlobals("flex gap-0")).toBe(0)
  })

  // 任务列表一行的操作按钮：几个 icon-xs，`flex items-center gap-1`
  it("splits the 4px gap between a task row's action buttons", async () => {
    const source = readFileSync("src/components/tasks/task-row.tsx", "utf8")
    expect(source).toContain('"flex items-center gap-1"')
    const decls = await compiledDecls(COARSE_HIT_40)
    const gap = touchGapFromGlobals("flex items-center gap-1")
    const row = layoutRow(
      [
        [24, 24],
        [24, 24],
        [24, 24],
      ],
      4
    )
    const [a, b, c] = hitRects(decls, row, [0, 1, 2], gap)
    expect(a.right).toBe(26)
    expect(b.left).toBe(26)
    expect(b.right).toBe(54)
    expect(c.left).toBe(54)
  })

  // 输入框底部：「+」（icon-xs）和设置（xs，带文字），`items-end gap-1`，
  // 上面紧贴编辑区
  it("splits the gap between the composer's + and settings, and stays out of the editor", async () => {
    const decls = await compiledDecls(COARSE_HIT_40)
    const gap = touchGapFromGlobals("flex min-w-0 items-end gap-1")
    const row = layoutRow(
      [
        [24, 24],
        [90, 24],
      ],
      4
    )
    const [add, settings] = hitRects(decls, row, [0, 1], gap, { roomTop: 0 })
    // 「+」伸进 4px 空隙的一半；设置本身就比 40px 宽，不往外伸
    expect(add.right).toBe(26)
    expect(settings.left).toBe(28)
    // 编辑区在 y < 0：两个按钮都不往上伸
    expect(add.top).toBe(0)
    expect(settings.top).toBe(0)
    // 往下照样扩，单独的方向满 40
    expect(add.bottom).toBe(32)
    expect(add.left).toBe(-8)
  })

  it("makes the composer's button row announce that the editor is above it", () => {
    const source = readFileSync("src/components/chat/message-input.tsx", "utf8")
    const row = source.indexOf("<ComposerAddMenu")
    const before = source.slice(Math.max(0, row - 600), row)
    expect(before).toMatch(/items-end gap-1",\s*TOUCH_ROOM_TOP_0\s*\)/)
  })

  it("registers the room variables as non-inherited, unlimited by default", () => {
    const css = readFileSync("src/app/globals.css", "utf8")
    for (const name of ["--touch-room-top", "--touch-room-bottom"]) {
      const rule = new RegExp(`@property ${name} \\{([^}]*)\\}`).exec(css)
      expect(rule?.[1], name).toMatch(/inherits:\s*false/)
      expect(rule?.[1], name).toMatch(/initial-value:\s*20px/)
    }
  })

  it("sets the room to 0 for direct children only", async () => {
    for (const [classes, name] of [
      [TOUCH_ROOM_TOP_0, "--touch-room-top"],
      [TOUCH_ROOM_BOTTOM_0, "--touch-room-bottom"],
    ] as const) {
      const compiler = await compile(
        "@theme { --spacing: 0.25rem; }\n@tailwind utilities;",
        {}
      )
      const css = compiler.build(classes.split(" "))
      expect(css).toMatch(new RegExp(`&>\\* \\{\\s*${name}: 0px;`))
    }
  })
})

describe("rows announce their gap to the small buttons in them", () => {
  it("sets --touch-gap to the same length as the gap", async () => {
    for (const [classes, px] of [
      [TOUCH_GAP_0_5, 2],
      [TOUCH_GAP_1, 4],
    ] as const) {
      // 每组单独编：同一个 compiler 会把前面编过的类也带上
      const compiler = await compile(
        "@theme { --spacing: 0.25rem; }\n@tailwind utilities;",
        {}
      )
      const css = compiler.build(classes.split(" "))
      const gap = /gap: calc\(var\(--spacing\) \* ([\d.]+)\)/.exec(css)
      expect(Number(gap?.[1]) * 4).toBe(px)
      // 只给直接子元素
      expect(css).toMatch(new RegExp(`&>\\* \\{\\s*--touch-gap: ${px}px;`))
    }
  })

  it("registers --touch-gap as non-inherited so nested rows do not reuse it", () => {
    const css = readFileSync("src/app/globals.css", "utf8")
    const rule = /@property --touch-gap \{([^}]*)\}/.exec(css)
    expect(rule?.[1]).toMatch(/inherits:\s*false/)
    expect(rule?.[1]).toMatch(/initial-value:\s*0px/)
  })

  it.each([
    ["src/components/ai-elements/mermaid-block.tsx", "TOUCH_GAP_0_5"],
    ["src/components/message/message-list-view.tsx", "TOUCH_GAP_1"],
    ["src/components/chat/message-queue-display.tsx", "TOUCH_GAP_1"],
    ["src/components/message/delegation-status-row.tsx", "TOUCH_GAP_1"],
  ])("%s tells its button row the gap", (file, name) => {
    const source = readFileSync(file, "utf8")
    expect(source).toMatch(new RegExp(`\\$\\{${name}\\}|${name},`))
  })
})

/**
 * globals.css 里给会换行、竖着排的行（flex-wrap、flex-col、grid）告诉直接子元素的
 * 上下空地（px）：没有行距是 0，有 gap-* / gap-y-* 是半个行距。别的行按 20（不限）。
 */
function roomFromGlobals(rowClasses: string): number {
  const css = readFileSync("src/app/globals.css", "utf8")
  const classes = rowClasses.split(/\s+/)
  const names = (list: string) =>
    list.split(",").map((x) => x.trim().slice(1).replace(/\\/g, ""))
  let room = 20
  for (const [, layouts, gaps, top, bottom] of css.matchAll(
    /:where\(([^)]*)\)(?::where\(([^)]*)\))? > \* \{\s*--touch-room-top: ([^;]+);\s*--touch-room-bottom: ([^;]+);/g
  )) {
    if (!classes.some((c) => names(layouts).includes(c))) continue
    if (gaps && !classes.some((c) => names(gaps).includes(c))) continue
    expect(top).toBe(bottom)
    const m = /calc\(var\(--spacing\) \* ([\d.]+)\)/.exec(top)
    // 后面的规则盖过前面的（都是 :where，权重一样）
    room = m ? Number(m[1]) * 4 : Number.parseFloat(top)
  }
  return room
}

describe("rows that wrap or stack keep small buttons off each other vertically", () => {
  it("maps wrapping and stacked rows to half their row gap", () => {
    for (const [cls, px] of [
      ["flex flex-wrap gap-2", 4],
      ["flex flex-wrap gap-y-1", 2],
      ["flex flex-wrap gap-x-2", 0],
      ["flex flex-wrap", 0],
      ["flex flex-col gap-1", 2],
      ["flex flex-col", 0],
      ["grid gap-3", 6],
      ["flex items-center gap-2", 20],
    ] as const) {
      expect(roomFromGlobals(cls), cls).toBe(px)
    }
  })

  // 任务列表的空状态：「清除搜索」和「全部状态」两个 xs，
  // `flex flex-wrap items-center justify-center gap-2`，窄屏上换成两行
  it("keeps the two empty-state buttons apart when they wrap onto two lines", async () => {
    const source = readFileSync("src/components/tasks/task-list.tsx", "utf8")
    const rowClasses = "flex flex-wrap items-center justify-center gap-2"
    expect(source).toContain(`"${rowClasses}"`)
    const decls = await compiledDecls(COARSE_HIT_40)
    const room = roomFromGlobals(rowClasses)
    const env = { roomTop: room, roomBottom: room }
    // 换行以后各占一行：都是这一行的第一个也是最后一个，但 DOM 里一个在前、一个在后
    const [upper] = hitRects(
      decls,
      layoutRow(
        [
          [90, 24],
          [90, 24],
        ],
        8
      ),
      [0],
      8,
      env
    )
    const [lower] = hitRects(
      decls,
      layoutRow(
        [
          [90, 24],
          [90, 24],
        ],
        8
      ),
      [1],
      8,
      env
    )
    // 下面那一行从 y = 24 + 8 开始
    const lowerTop = 32 + lower.top
    expect(upper.bottom).toBeLessThanOrEqual(lowerTop)
    expect(upper.bottom).toBe(28)
    expect(lowerTop).toBe(28)
  })
})
