import { describe, it, expect } from 'vitest'
import {
  deltaTone,
  isFlatAfterRounding,
  resolveDeltaDisplay,
  type DeltaDisplay,
} from './delta-display'

/**
 * 决策 1 矩阵的守护。这些断言**逐字钉住 2026-09-23 拍板的口径**——
 * 改动它们等于改产品语义，不要为了让实现通过而顺手改断言。
 */
describe('resolveDeltaDisplay（决策 1 矩阵）', () => {
  describe('base > 0：正常百分比，方向由商的符号决定', () => {
    it('常规涨跌', () => {
      expect(resolveDeltaDisplay(12, 10)).toEqual({ kind: 'pct', value: 0.2 })
      expect(resolveDeltaDisplay(8, 10)).toEqual({ kind: 'pct', value: -0.2 })
    })

    it('归零 = -100%，由正转负 = -150%（方向本就正确，不需特判）', () => {
      expect(resolveDeltaDisplay(0, 10)).toEqual({ kind: 'pct', value: -1 })
      expect(resolveDeltaDisplay(-5, 10)).toEqual({ kind: 'pct', value: -1.5 })
    })
  })

  describe('base < 0：硬约束——不输出任何基于负分母的百分比', () => {
    it('当期为正 → 由负转正', () => {
      // #283 生产实例：南昌梦祥店「本周」业绩，基期 −2,646.00、当期 +264.00。
      // 旧式算出 −109.98% 渲染成红色下滑，方向恰好反了。
      expect(resolveDeltaDisplay(264, -2646)).toEqual({ kind: 'turnedPositive' })
    })

    it('当期仍为负 → 未转正', () => {
      expect(resolveDeltaDisplay(-20000, -6104)).toEqual({ kind: 'notTurned' })
    })

    it('亏损减半但仍亏 → 未转正（拍板取舍：按当期值本身正负着色）', () => {
      // 已知代价：「亏损收窄」这个改善看不出来。这是 2026-09-23 明确拍的，
      // 若要改成按 cur-base 方向着绿，需重新拍板——别在这里单方面改。
      expect(resolveDeltaDisplay(-500, -1000)).toEqual({ kind: 'notTurned' })
    })

    it('当期恰好为 0 → 未转正（措辞不用「仍为负」正是为了涵盖这格）', () => {
      expect(resolveDeltaDisplay(0, -1000)).toEqual({ kind: 'notTurned' })
    })

    it('极小负基期也不出百分比（否则会爆出 ±1000% 级的假数字）', () => {
      expect(resolveDeltaDisplay(100, -0.01)).toEqual({ kind: 'turnedPositive' })
    })
  })

  describe('base === 0 / 空 / 非有限 → na', () => {
    it('零基期是除零，无论当期多少都算不出', () => {
      expect(resolveDeltaDisplay(10, 0)).toEqual({ kind: 'na' })
      expect(resolveDeltaDisplay(0, 0)).toEqual({ kind: 'na' })
      expect(resolveDeltaDisplay(-10, 0)).toEqual({ kind: 'na' })
    })

    it('负零作基期：走零分支，不被误判成负基期', () => {
      // -0 < 0 为 false、-0 > 0 也为 false，所以必须落在 base === 0 这一格。
      expect(resolveDeltaDisplay(10, -0)).toEqual({ kind: 'na' })
    })

    it('负零作当期：不被误判成「已转正」', () => {
      // `cur > 0` 对 -0 为 false，所以 base<0 时落 notTurned（与 cur===0 同格，符合「未转正」的措辞）。
      expect(resolveDeltaDisplay(-0, -10)).toEqual({ kind: 'notTurned' })
      // base>0 时 -0 照常参与除法：(-0-10)/10 = -1 → -100%
      expect(resolveDeltaDisplay(-0, 10)).toEqual({ kind: 'pct', value: -1 })
    })

    it('null / undefined', () => {
      expect(resolveDeltaDisplay(10, null)).toEqual({ kind: 'na' })
      expect(resolveDeltaDisplay(null, 10)).toEqual({ kind: 'na' })
      expect(resolveDeltaDisplay(undefined, undefined)).toEqual({ kind: 'na' })
    })

    it('NaN / ±Infinity —— `== null` 接不住 NaN，必须单独挡', () => {
      expect(resolveDeltaDisplay(NaN, 10)).toEqual({ kind: 'na' })
      expect(resolveDeltaDisplay(10, NaN)).toEqual({ kind: 'na' })
      expect(resolveDeltaDisplay(Infinity, 10)).toEqual({ kind: 'na' })
      expect(resolveDeltaDisplay(10, -Infinity)).toEqual({ kind: 'na' })
    })

    it('入参有限但商溢出 → na', () => {
      // 弱版本：商本身就是 Infinity。
      expect(resolveDeltaDisplay(1, 1e-320)).toEqual({ kind: 'na' })
    })

    it('商有限、仅 ×100 才溢出 → na（守卫必须落在最终渲染值上）', () => {
      // ⚠️ 这一档才是 #307 闸门 2 codex 那条 P3 的真正形态，也是本模块初版漏掉的：
      // (1 - 1e-307)/1e-307 ≈ 1.0e307 —— **有限**，只查 value 会放行；
      // 但渲染的是 value*100 = Infinity，会输出 "+Infinity%" 且被 deltaTone 判成绿色。
      const d = resolveDeltaDisplay(1, 1e-307)
      expect(d).toEqual({ kind: 'na' })
      // 反向确认：商确实有限，证明这不是上一条的重复
      expect(Number.isFinite((1 - 1e-307) / 1e-307)).toBe(true)
    })

    it('负向的 ×100 溢出同样挡住', () => {
      expect(resolveDeltaDisplay(-1, 1e-307)).toEqual({ kind: 'na' })
    })
  })
})

describe('deltaTone（配色语义）', () => {
  it('负基期两态直接定色，不看数值', () => {
    expect(deltaTone({ kind: 'turnedPositive' }, 2)).toBe('positive')
    expect(deltaTone({ kind: 'notTurned' }, 2)).toBe('negative')
  })

  it('na 一律灰', () => {
    expect(deltaTone({ kind: 'na' }, 2)).toBe('neutral')
  })

  it('pct 按展示精度舍入后判向——避免「显示持平、颜色是绿」的错配', () => {
    expect(deltaTone({ kind: 'pct', value: 0.2 }, 2)).toBe('positive')
    expect(deltaTone({ kind: 'pct', value: -0.2 }, 2)).toBe('negative')
    // +0.002% 在 2 位小数下舍成 0.00 → 中性，不能是绿
    expect(deltaTone({ kind: 'pct', value: 0.00002 }, 2)).toBe('neutral')
    // 对照：+0.02% 在 2 位小数下仍出数，是绿（阈值比 analyst 严一位）
    expect(deltaTone({ kind: 'pct', value: 0.0002 }, 2)).toBe('positive')
  })

  it('同一个值在两种精度下的 tone 可以不同（这正是两处阈值必须各自传的原因）', () => {
    const v: DeltaDisplay = { kind: 'pct', value: 0.004 } // +0.4%
    expect(deltaTone(v, 2)).toBe('positive') // 数据中心：+0.40%
    expect(deltaTone(v, 0)).toBe('neutral') // 首页看板：Math.round → 0%
  })
})

describe('isFlatAfterRounding（决策 3）', () => {
  it('真 0 与舍入后的 0 都算持平', () => {
    expect(isFlatAfterRounding(0, 2)).toBe(true)
    expect(isFlatAfterRounding(0.00002, 2)).toBe(true)
    expect(isFlatAfterRounding(-0.00002, 2)).toBe(true)
  })

  it('刚好够一个最小刻度的不算', () => {
    expect(isFlatAfterRounding(0.0001, 2)).toBe(false)
    expect(isFlatAfterRounding(0.01, 0)).toBe(false) // +1%，整数精度下够一格
  })

  it('整数精度下 0.4% 被舍成 0（首页看板的伪持平）', () => {
    expect(isFlatAfterRounding(0.004, 0)).toBe(true)
    expect(isFlatAfterRounding(-0.004, 0)).toBe(true)
  })

  it('−0.5% 这格：toFixed 与 Math.round 的分叉点', () => {
    // (-0.5).toFixed(0) === '-1'（away from zero），而 Math.round(-0.5) === -0（向 +∞）。
    // 若展示层用 Math.round 判空、守卫用 toFixed 判持平，这里就会「不算持平、却显示 0%」——
    // 正是 #315 要消灭的那种自相矛盾。所以 TrendArrow 的展示值也必须走 toFixed。
    expect(isFlatAfterRounding(-0.005, 0)).toBe(false)
  })
})
