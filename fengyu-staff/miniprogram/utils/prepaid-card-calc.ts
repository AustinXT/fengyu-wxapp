



export interface PrepaidComputeInput {
  
  payableAmount: number
  
  customerCardBalance: number
  
  useCard: boolean
}

export interface PrepaidComputeResult {
  
  prepaidCardAmount: number
  
  paidAmount: number
  
  showPayMethodGroup: boolean
}


export function computePrepaidDeduction(input: PrepaidComputeInput): PrepaidComputeResult {
  const payable = Math.max(0, Number(input.payableAmount) || 0)
  const balance = Math.max(0, Number(input.customerCardBalance) || 0)

  const prepaidRaw =
    input.useCard && balance > 0 ? Math.min(balance, payable) : 0
  const prepaidCardAmount = round2(prepaidRaw)
  const paidAmount = round2(Math.max(0, payable - prepaidCardAmount))

  return {
    prepaidCardAmount,
    paidAmount,
    showPayMethodGroup: paidAmount > 0,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
