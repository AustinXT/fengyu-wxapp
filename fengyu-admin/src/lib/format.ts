
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
