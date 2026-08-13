import { NextResponse } from 'next/server'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { lakalaOnboardingApplications } from '@db/lakala-onboarding'

async function ensureEContractColumns(): Promise<void> {
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS e_contract_order_no TEXT`)
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS e_contract_apply_id TEXT`)
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS e_contract_result_url TEXT`)
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS e_contract_no TEXT`)
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS e_contract_status TEXT`)
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS e_contract_signed_at TIMESTAMPTZ`)
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>
    const orderNo = typeof payload.orderNo === 'string' ? payload.orderNo : ''
    const orgId = payload.orgId == null ? '' : String(payload.orgId)
    const status = typeof payload.ecStatus === 'string' ? payload.ecStatus : ''
    const ecNo = typeof payload.ecNo === 'string' ? payload.ecNo : ''
    if (!orderNo || !status) throw new Error('电子合同回调缺少 orderNo 或 ecStatus')
    const expectedOrgId = String(process.env.LAKALA_ECONTRACT_ORG_ID || process.env.LAKALA_ONBOARDING_ORG_CODE || '')
    if (!expectedOrgId || orgId !== expectedOrgId) throw new Error('电子合同回调机构号不匹配')

    // 按已确认的交接实现保留运行时补列；该回调不做签名校验。
    await ensureEContractColumns()
    const [application] = await db.select().from(lakalaOnboardingApplications)
      .where(eq(lakalaOnboardingApplications.eContractOrderNo, orderNo)).limit(1)
    if (!application) throw new Error('电子合同回调订单不存在')
    await db.update(lakalaOnboardingApplications).set({
      eContractStatus: status,
      eContractNo: status === 'COMPLETED' ? ecNo || application.eContractNo : application.eContractNo,
      eContractSignedAt: status === 'COMPLETED' ? new Date() : application.eContractSignedAt,
      lastErrorMessage: null,
      updatedAt: new Date(),
    }).where(eq(lakalaOnboardingApplications.id, application.id))
    return NextResponse.json({ code: '000000', msg: 'SUCCESS' })
  } catch (error) {
    return NextResponse.json(
      { code: '999999', msg: error instanceof Error ? error.message : '电子合同回调处理失败' },
      { status: 400 },
    )
  }
}
