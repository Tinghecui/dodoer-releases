// 团队功能（CoTeam）报错时给员工看的那一句（#1390 完成标准 4）：按错误码写
// 人话，不出现服务端写给开发者的原文；原文只用 console.warn 记一行方便排查。

import type { CoworkTeamError } from "@/lib/cowork/team"

/** `CoworkTeam` 命名空间里报错用的几条文案。 */
export type TeamErrorKey =
  | "errorNotFound"
  | "errorForbidden"
  | "errorSharingDisabled"
  | "errorRateLimited"
  | "errorGeneric"

const KEYS: Record<string, TeamErrorKey> = {
  not_found: "errorNotFound",
  forbidden: "errorForbidden",
  sharing_disabled: "errorSharingDisabled",
  rate_limited: "errorRateLimited",
}

/**
 * 错误码对应的那句人话；不认识的（`invalid`、`unknown`、网络断了等）一律
 * 「出了点问题，稍后再试」。`t` 是 `CoworkTeam` 命名空间的翻译函数。
 */
export function teamErrorText(
  code: string,
  t: (key: TeamErrorKey) => string
): string {
  return t(KEYS[code] ?? "errorGeneric")
}

/**
 * 把一次失败记一行日志（带服务端原文），返回界面上要存的错误码。`where` 是
 * 出错的地方，只给排查的人看。
 */
export function noteTeamError(where: string, e: CoworkTeamError): string {
  console.warn(`[cowork-team] ${where} failed: ${e.code} ${e.message}`)
  return e.code || "unknown"
}
