// 智能体装上了但没装完整时的那句提示（#1111）。
//
// 后端认出来的 `agent_install_broken`：比如 codex-acp 拉起的嵌套 Codex 缺了本机
// 平台的程序包，一启动就退出。门户后面的智能体是管理员统一装的，员工在设置里
// 修不好，所以提示指向管理员和门户的 Agent 页；别的部署照旧指向智能体设置。

import type { CoworkTextKey } from "./i18n"
import { getCachedCoworkInfo, type CoworkInfo } from "./info"

/** 这句提示用哪条文字。`info` 默认读缓存的 Cowork 信息，还没读到算「不在门户后面」。 */
export function agentInstallBrokenTextKey(
  info: CoworkInfo | null = getCachedCoworkInfo()
): CoworkTextKey {
  return info?.portal === true
    ? "agentInstallBrokenPortal"
    : "agentInstallBroken"
}
