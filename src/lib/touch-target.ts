// 触屏兜底用的几组类名，放在一处，各组件拼进自己的 className。
//
// 判断都用 CSS 媒体查询，不看屏幕宽度：iPad 接了鼠标就按有鼠标处理，
// 小窗口的桌面也不会被当成手机。
//
// 这里的类名必须写成完整的字面量（Tailwind 扫描源码生成 CSS，拼接出来的类名
// 不会生成样式）。

/**
 * 不能悬停的设备上（`hover: none`），原来悬停才出现的按钮一直半透明显示、
 * 可以点。和原来的 `opacity-0 group-hover:opacity-100` 并用：有鼠标的设备
 * 不受影响，仍然悬停才出现。`pointer-events-auto` 给那些隐藏时关掉了点击的按钮。
 */
export const HOVER_NONE_REVEAL =
  "[@media(hover:none)]:opacity-70 [@media(hover:none)]:pointer-events-auto"

/**
 * 粗指针设备上（`pointer: coarse`），用一块看不见的 `::after` 把点按区域
 * 撑大。按钮本身的尺寸、图标大小、排版都不变；按钮比目标尺寸大的那一边
 * （带文字的按钮横向），`min(0px, …)` 取 0，按钮自己就盖住了。
 * 按钮要是定位元素（`relative`、`absolute` 等），`::after` 才贴着它。
 *
 * 单独的按钮四个方向都往外扩，凑满 40×40（32 那组凑满 32×32）。
 * 横向挨着别的元素时（前面有兄弟元素 = 不是 `:first-child`，后面有 = 不是
 * `:last-child`），那一侧最多只往外扩半个间距：两个按钮把中间的空隙平分，
 * 互不重叠；复制按钮也只伸到它和消息气泡之间空隙的一半，不会伸进气泡。
 * CSS 拿不到父元素的 `gap`：globals.css 里给常用的 `gap-*` / `gap-x-*`
 * （0.5 到 8）写了规则，把间距告诉直接子元素（`--touch-gap`），用这些类排的行
 * 不用另外声明；也可以用 TOUCH_GAP_* 明写。都没有的行（`gap-0`、响应式的
 * `sm:gap-*`、用 margin 隔开的）按 0 算，挨着的一侧就不往外扩。
 * `--touch-gap` 在 globals.css 里注册成不继承的，只有那一行的直接子元素
 * 拿得到，嵌在里面的另一组按钮不会误用外面那一行的间距；按钮自己把它抄到
 * 会继承的 `--touch-hit-gap` 上，`::after` 才读得到。
 * 横向用逻辑方向（`start`、`end`），阿拉伯语从右往左时也对。
 * 竖向照样上下各扩到满 40px。CSS 看不出按钮上下挨着什么，上面或下面紧贴着
 * 可点、可编辑的东西（输入框底部那一排按钮上面就是编辑区）时，那一行用
 * TOUCH_ROOM_TOP_0 / TOUCH_ROOM_BOTTOM_0 告诉子元素那一侧没有空地，那一侧就
 * 不往外扩（`--touch-room-top` / `--touch-room-bottom`，同样注册成不继承的）。
 */
export const COARSE_HIT_40 =
  "pointer-coarse:[--touch-hit-gap:var(--touch-gap,0px)] pointer-coarse:[--touch-hit-room-top:var(--touch-room-top,20px)] pointer-coarse:[--touch-hit-room-bottom:var(--touch-room-bottom,20px)] pointer-coarse:after:absolute pointer-coarse:after:top-[max(min(0px,calc(50%-20px)),calc(var(--touch-hit-room-top,20px)*-1))] pointer-coarse:after:bottom-[max(min(0px,calc(50%-20px)),calc(var(--touch-hit-room-bottom,20px)*-1))] pointer-coarse:after:start-[min(0px,calc(50%-20px))] pointer-coarse:after:end-[min(0px,calc(50%-20px))] pointer-coarse:[&:not(:first-child)]:after:start-[max(min(0px,calc(50%-20px)),calc(var(--touch-hit-gap,0px)/-2))] pointer-coarse:[&:not(:last-child)]:after:end-[max(min(0px,calc(50%-20px)),calc(var(--touch-hit-gap,0px)/-2))]"

/** 同上，至少 32×32：排队消息这种挤在一起的小按钮。 */
export const COARSE_HIT_32 =
  "pointer-coarse:[--touch-hit-gap:var(--touch-gap,0px)] pointer-coarse:[--touch-hit-room-top:var(--touch-room-top,20px)] pointer-coarse:[--touch-hit-room-bottom:var(--touch-room-bottom,20px)] pointer-coarse:after:absolute pointer-coarse:after:top-[max(min(0px,calc(50%-16px)),calc(var(--touch-hit-room-top,20px)*-1))] pointer-coarse:after:bottom-[max(min(0px,calc(50%-16px)),calc(var(--touch-hit-room-bottom,20px)*-1))] pointer-coarse:after:start-[min(0px,calc(50%-16px))] pointer-coarse:after:end-[min(0px,calc(50%-16px))] pointer-coarse:[&:not(:first-child)]:after:start-[max(min(0px,calc(50%-16px)),calc(var(--touch-hit-gap,0px)/-2))] pointer-coarse:[&:not(:last-child)]:after:end-[max(min(0px,calc(50%-16px)),calc(var(--touch-hit-gap,0px)/-2))]"

/**
 * 一行的间距，同时把它告诉直接子元素（`--touch-gap`），里面带 COARSE_HIT_*
 * 的小按钮就往空隙里伸一半。间距和变量写在一起，改间距时不会忘了改变量。
 */
export const TOUCH_GAP_0_5 = "gap-0.5 [&>*]:[--touch-gap:2px]"
export const TOUCH_GAP_1 = "gap-1 [&>*]:[--touch-gap:4px]"

/**
 * 一行的上面（下面）紧贴着可点、可编辑的内容：里面带 COARSE_HIT_* 的小按钮
 * 在那一侧不往外扩，点编辑区下沿不会落到按钮上。只给直接子元素。
 */
export const TOUCH_ROOM_TOP_0 = "[&>*]:[--touch-room-top:0px]"
export const TOUCH_ROOM_BOTTOM_0 = "[&>*]:[--touch-room-bottom:0px]"

/**
 * 粗指针设备上让按钮本身至少 32×32，图标居中，不用 `::after`：给挨在一起的
 * 小图标按钮（排队消息的编辑、删除）。居中的 `::after` 会伸到隔壁按钮上，
 * 后画的那个盖住前一个的半边，点编辑可能落到删除上。触屏上这一行会变高一点，
 * 有鼠标的设备上尺寸和排版不变。
 */
export const COARSE_BOX_32 =
  "pointer-coarse:inline-flex pointer-coarse:items-center pointer-coarse:justify-center pointer-coarse:min-h-8 pointer-coarse:min-w-8"

/**
 * 粗指针设备上让盖在缩略图上的小叉本身变大到 24×24，图标居中，不用看不见的
 * `::after`：看不见的区域会盖住缩略图，点缩略图右上角想看预览却删了附件。
 * 叉变大了，看得见的地方就是能删的地方，叉以外的缩略图照样是打开预览。
 */
export const COARSE_VISIBLE_BOX_24 =
  "pointer-coarse:inline-flex pointer-coarse:items-center pointer-coarse:justify-center pointer-coarse:size-6"
