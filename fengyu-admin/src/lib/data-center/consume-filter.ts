
import { sql, type SQL } from 'drizzle-orm'
import { DEPOSIT_REFUND_REMARK } from '@/lib/service-remark'

export function excludeDepositRefundSql(soAlias = 'so'): SQL {
  return sql`${sql.raw(soAlias)}.remark IS DISTINCT FROM ${DEPOSIT_REFUND_REMARK}`
}
