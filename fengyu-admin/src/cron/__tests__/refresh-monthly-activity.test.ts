/**
 * STEP monthlyActivity — monthly_activity 三段式 SQL 形态测试
 *
 * 口径守护（按「当月到店天数」service_date 去重，非服务单次数）：
 *   段 1：全表置 NULL（幂等清理）
 *   段 2：当月有到店记录顾客按去重天数打 二次(>=2)/一次(=1) 客活，含当月窗口
 *   段 3：会员客当月未到店置 0次客活
 */

import { describe, it, expect } from 'vitest'
import {
  RESET_MONTHLY_ACTIVITY_SQL,
  UPDATE_MONTHLY_ACTIVITY_SQL,
  SET_ZERO_ACTIVITY_SQL,
} from '../steps/refresh-monthly-activity'

describe('cron-worker STEP monthlyActivity — monthly_activity 三段式 SQL', () => {
  describe('段 1：全表置 NULL', () => {
    it('SET monthly_activity = NULL', () => {
      expect(RESET_MONTHLY_ACTIVITY_SQL).toMatch(/SET\s+monthly_activity\s*=\s*NULL/i)
    })

    it('WHERE 带 IS NOT NULL 避免无谓更新', () => {
      expect(RESET_MONTHLY_ACTIVITY_SQL).toMatch(/monthly_activity\s+IS\s+NOT\s+NULL/i)
    })
  })

  describe('段 2：按当月到店天数分类', () => {
    it("仅统计 status='已完成' 服务单", () => {
      expect(UPDATE_MONTHLY_ACTIVITY_SQL).toMatch(/so\.status\s*=\s*'已完成'/)
    })

    it('按 service_date 去重计天数（COUNT DISTINCT service_date）', () => {
      expect(UPDATE_MONTHLY_ACTIVITY_SQL).toMatch(
        /COUNT\(DISTINCT\s+so\.service_date\)/i,
      )
    })

    it('当月窗口：date_trunc month 下界 + 1 month 上界', () => {
      expect(UPDATE_MONTHLY_ACTIVITY_SQL).toMatch(/date_trunc\(\s*'month'\s*,\s*CURRENT_DATE\s*\)/i)
      expect(UPDATE_MONTHLY_ACTIVITY_SQL).toMatch(/INTERVAL\s*'1 month'/i)
    })

    it('天数 >= 2 → 二次客活', () => {
      expect(UPDATE_MONTHLY_ACTIVITY_SQL).toMatch(/vd\.days\s*>=\s*2\s+THEN\s+'二次客活'/)
    })

    it('ELSE → 一次客活（去重后至少 1 天）', () => {
      expect(UPDATE_MONTHLY_ACTIVITY_SQL).toMatch(/ELSE\s+'一次客活'/)
    })

    it('结果 cast 成 monthly_activity 枚举', () => {
      expect(UPDATE_MONTHLY_ACTIVITY_SQL).toMatch(/::monthly_activity/)
    })

    it('段 2 不写 customer_type 守卫（含非会员到店顾客）', () => {
      expect(UPDATE_MONTHLY_ACTIVITY_SQL).not.toMatch(/customer_type/)
    })
  })

  describe('段 3：会员客当月未到店置 0次客活', () => {
    it("SET monthly_activity = '0次客活'", () => {
      expect(SET_ZERO_ACTIVITY_SQL).toMatch(/SET\s+monthly_activity\s*=\s*'0次客活'/)
    })

    it("WHERE 带 customer_type = '会员客' 守卫", () => {
      expect(SET_ZERO_ACTIVITY_SQL).toMatch(/customer_type\s*=\s*'会员客'/)
    })

    it('只覆盖段 2 没分到的（monthly_activity IS NULL）', () => {
      expect(SET_ZERO_ACTIVITY_SQL).toMatch(/monthly_activity\s+IS\s+NULL/i)
    })

    it('cast 成 monthly_activity 枚举', () => {
      expect(SET_ZERO_ACTIVITY_SQL).toMatch(/::monthly_activity/)
    })
  })

  describe('整体不变量', () => {
    it('0次客活仅落在会员客身上（非会员未到店保持 NULL）', () => {
      expect(SET_ZERO_ACTIVITY_SQL).toMatch(/customer_type\s*=\s*'会员客'/)
      expect(UPDATE_MONTHLY_ACTIVITY_SQL).not.toMatch(/'0次客活'/)
    })
  })
})
