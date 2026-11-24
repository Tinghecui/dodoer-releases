// 启动页入口。单独放一个文件：CSP 是 default-src 'self'，页面里不写内联脚本。
import { start } from "./launcher.js"

start(window)
