/**
 * UI 展示格式化 helper（围绕 PII 脱敏）。
 *
 * - `formatPhoneSafe` / `formatIdCardSafe` 是 pii.ts mask 函数的别名，用于"列表展示别人 PII"场景
 * - `formatPhoneDisplay({ full })` 提供按需明文 / 默认脱敏的统一展示入口
 *
 * 编辑表单（用户自己改自己的手机号）应保留明文 — 用 `formatPhoneDisplay(phone, { full: true })`。
 *
 * 历史 `lib/utils.ts` 的 `formatPhone` 已标记 @deprecated，新代码请用本文件提供的 API。
 */
import { maskPhone, maskIdCard } from './pii'

export const formatPhoneSafe = maskPhone
export const formatIdCardSafe = maskIdCard

export function formatPhoneDisplay(
  phone: string | null | undefined,
  opts?: { full?: boolean },
): string {
  if (!phone) return '—'
  if (opts?.full) return phone
  return maskPhone(phone)
}
