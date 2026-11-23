// coteam iOS 壳在每个页面加载前注入（见 navigation.rs 的 NEW_WINDOW_SCRIPT）。
// iOS 上 wry 不处理新窗口请求：服务器网页用 window.open 或 target="_blank" 打开的链接，
// 点了没有任何反应。这里把「在新窗口打开别的网站」改成在当前网页视图里导航过去，
// 壳的导航规则会拦下它、交给系统浏览器，当前页面不动。同源的、空地址的新窗口照旧交给原来的 window.open。
;(function () {
  "use strict"

  // 别的网站的 http/https 地址返回完整地址，其他情况返回 null
  function externalUrl(raw) {
    if (raw === undefined || raw === null || raw === "") return null
    var here
    var target
    try {
      here = new URL(window.location.href)
      target = new URL(String(raw), here)
    } catch {
      return null
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return null
    if (target.origin === here.origin) return null
    return target.href
  }

  var originalOpen = window.open
  window.open = function (url) {
    var target = externalUrl(url)
    if (target) {
      window.location.assign(target)
      // 没有真的开新窗口；外链本来就常带 noreferrer，调用方拿到的也是 null
      return null
    }
    return originalOpen.apply(window, arguments)
  }

  // 挂在 window 的冒泡阶段，页面自己的点击处理（比如外链确认框）先跑；它已经拦下的不管
  window.addEventListener("click", function (event) {
    if (event.defaultPrevented) return
    var el = event.target
    var anchor = el && el.closest ? el.closest("a[href]") : null
    if (!anchor) return
    var frame = (anchor.getAttribute("target") || "").toLowerCase()
    if (
      frame === "" ||
      frame === "_self" ||
      frame === "_top" ||
      frame === "_parent"
    ) {
      return
    }
    var target = externalUrl(anchor.getAttribute("href"))
    if (!target) return
    event.preventDefault()
    window.location.assign(target)
  })
})()
