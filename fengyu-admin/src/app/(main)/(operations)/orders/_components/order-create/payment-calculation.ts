/** 本次实付中由充值卡覆盖的部分不能再计入现金通道。 */
export function calculateSaleCashAmount(
  totalReceived: number,
  saleCardAmount: number,
  salePayable: number,
): number {
  const cashAmount = Math.round((totalReceived - saleCardAmount) * 100) / 100
  return Math.min(Math.max(0, cashAmount), Math.max(0, salePayable))
}

/** 线上 0 首付会走全额二维码，卡-only 部分付款须走线下确认。 */
export function requiresOfflineCardOnlyConfirmation(
  saleCardAmount: number,
  saleCashAmount: number,
  salePayable: number,
): boolean {
  return saleCardAmount > 0 && saleCashAmount === 0 && salePayable > 0
}
