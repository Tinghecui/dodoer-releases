/**
 * 手机上侧边抽屉（会话列表、右侧面板）的四边留白。
 *
 * 抽屉渲染在工作区根容器外面（portal 到 body），拿不到根容器的安全区留白；
 * 它自己的边距只有 8px，竖屏时顶部被刘海挡住、底部压在横条上，横屏时左右
 * 被刘海挡住。这里把每一边改成「8px 和对应安全区里取大的」，没有安全区的
 * 设备（桌面、普通浏览器）仍是 8px。用物理方向的 left/right：安全区本身是
 * 物理方向的，抽屉的 left/right 也是。
 *
 * 手机上软键盘弹起时，抽屉的顶边跟可见区域走（iOS 会把页面上推），底边让出
 * 键盘遮住的那块（`--app-kbd-lift`，由 useVisualViewport 写入），整个抽屉收在
 * 键盘以上。要带上和抽屉自带 `inset-y-0` 一样的 data 变体，优先级才压得过它；
 * 没有变量时（桌面、没订阅）退回 0，和原来一样铺满高度。
 */
export const SIDE_DRAWER_SAFE_AREA_CLASS =
  "data-[swipe-axis=x]:top-[var(--app-vv-top,0px)] data-[swipe-axis=x]:bottom-[var(--app-kbd-lift,0px)] mt-[max(0.5rem,env(safe-area-inset-top))] mb-[max(0.5rem,env(safe-area-inset-bottom))] ml-[max(0.5rem,env(safe-area-inset-left))] mr-[max(0.5rem,env(safe-area-inset-right))]"
