/** 按行应付比例分摊订单级抵扣，末行吸收尾差。 */
export function allocateDiscountPerLine(priceLines: number[], discountAmount: number): number[] {
  const total = priceLines.reduce((sum, value) => sum + value, 0)
  const discount = Math.max(0, Math.min(discountAmount, total))
  if (discount <= 0 || total <= 0) return priceLines.map(() => 0)

  const shares: number[] = []
  let allocated = 0
  for (let index = 0; index < priceLines.length - 1; index++) {
    const share = Math.round((discount * priceLines[index] / total) * 100) / 100
    shares.push(share)
    allocated += share
  }
  shares.push(Math.max(0, Math.round((discount - allocated) * 100) / 100))
  return shares
}

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
