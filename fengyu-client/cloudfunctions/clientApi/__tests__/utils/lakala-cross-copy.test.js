/**
 * 拉卡拉工具跨副本一致性守护
 *
 * 项目规范：禁止跨端共享代码目录，clientApi / payNotify / admin 各保留独立 lakala 副本，
 * 一致性靠测试守护（详见根 CLAUDE.md「禁止跨端共享代码目录」）。
 *
 * 守护两件事：
 *  1. clientApi 与 payNotify 的 lakala-sign.js / lakala-config.js **字节一致**（签名算法 + PEM 归一化不漂移）。
 *  2. 三端（clientApi / payNotify / admin）的配置读取都含 `normalizePem`（PEM \n 归一化），
 *     防止有人删掉它导致 `DECODER routines::unsupported` 加签/验签全挂的回归（联调根因）。
 */
const fs = require('fs')
const path = require('path')

const CLIENT = path.resolve(__dirname, '../../utils')
const PAYNOTIFY = path.resolve(__dirname, '../../../payNotify/utils')
const ADMIN_LAKALA_CLIENT = path.resolve(
  __dirname,
  '../../../../../fengyu-admin/src/lib/lakala-client.ts',
)

function read(p) {
  return fs.readFileSync(p, 'utf8')
}

describe('lakala 跨副本一致性守护', () => {
  test('lakala-sign.js：clientApi 与 payNotify 字节一致', () => {
    expect(read(path.join(CLIENT, 'lakala-sign.js'))).toBe(
      read(path.join(PAYNOTIFY, 'lakala-sign.js')),
    )
  })

  test('lakala-config.js：clientApi 与 payNotify 字节一致', () => {
    expect(read(path.join(CLIENT, 'lakala-config.js'))).toBe(
      read(path.join(PAYNOTIFY, 'lakala-config.js')),
    )
  })

  test('lakala-client.js：clientApi 与 payNotify 字节一致（issue #37 定时补偿新增 payNotify 副本，queryTrade 字段映射 / 签名不漂移）', () => {
    expect(read(path.join(CLIENT, 'lakala-client.js'))).toBe(
      read(path.join(PAYNOTIFY, 'lakala-client.js')),
    )
  })

  test('三端配置读取都含 PEM \\n 归一化（normalizePem），防 DECODER unsupported 回归', () => {
    expect(read(path.join(CLIENT, 'lakala-config.js'))).toContain('normalizePem')
    expect(read(path.join(PAYNOTIFY, 'lakala-config.js'))).toContain('normalizePem')
    expect(read(ADMIN_LAKALA_CLIENT)).toContain('normalizePem')
  })

  // ===== #214 支付意图关单：三端接口与终态集合一致性 =====
  describe('#214 关单接口与 trade_state 终态集合', () => {
    const CLIENT_ORDER = path.resolve(__dirname, '../../routes/order.js')
    const PAYNOTIFY_INDEX = path.resolve(__dirname, '../../../payNotify/index.js')
    const ADMIN_ORDERS = path.resolve(
      __dirname, '../../../../../fengyu-admin/src/actions/orders.ts',
    )

    test('admin 的关单/查单走与 js 副本相同的 v3 路径与字段名', () => {
      const admin = read(ADMIN_LAKALA_CLIENT)
      const client = read(path.join(CLIENT, 'lakala-client.js'))
      for (const token of ['/v3/labs/relation/close', '/v3/labs/query/tradequery', 'origin_out_trade_no']) {
        expect(admin).toContain(token)
        expect(client).toContain(token)
      }
    })

    // 这条锁死的是 #214 真正的坑：REVOKED（当日交易撤销）是终态却长期被漏判，
    // 撤销过的单会永久占住支付意图——谁也发不了新支付、谁也关不掉订单。
    // pr-ready 审计发现首轮修复本身就漏了 queryLakalaStatus / confirmPayment 两处，
    // 所以这里直接把旧集合字面量钉成永久红灯，而不是只断言新集合存在。
    test('生产代码不得再出现 [FAIL, CLOSE] 旧终态集合（REVOKED 必须在列）', () => {
      const OLD_SET = /\[\s*'FAIL',\s*'CLOSE'\s*\]/
      for (const file of [CLIENT_ORDER, PAYNOTIFY_INDEX, ADMIN_ORDERS]) {
        const src = read(file)
          .split('\n')
          .filter((line) => !/^\s*(\*|\/\/)/.test(line))   // 注释里可以保留历史说明
          .join('\n')
        expect(src).not.toMatch(OLD_SET)
      }
    })

    test('三端终态分类字面一致（可释放 3 个 / 已付款 3 个）', () => {
      const RELEASABLE = /\[\s*'FAIL',\s*'CLOSE',\s*'REVOKED'\s*\]/
      const PAID = /\[\s*'SUCCESS',\s*'PART_REFUND',\s*'REFUND'\s*\]/
      for (const file of [CLIENT_ORDER, ADMIN_ORDERS]) {
        const src = read(file)
        expect(src).toMatch(RELEASABLE)
        expect(src).toMatch(PAID)
      }
      // payNotify 是被动兜底，只需认得可释放终态（它不做关单）
      expect(read(PAYNOTIFY_INDEX)).toMatch(/\[\s*'FAIL',\s*'CLOSE',\s*'REVOKED'\s*\]/)
      expect(read(PAYNOTIFY_INDEX)).toContain("tradeState === 'REVOKED'")
    })

    // clientApi 的跨 env 作废接口与 staffApi 的关单前闸门必须认同一组「可关闭状态」：
    // 两端漂移会让 staff 放行、clientApi 拒绝（或反之），表现为莫名其妙的「状态已变化」。
    test('可关闭订单状态集合三端一致（待支付 / 支付失败）', () => {
      const STAFF_ORDER = path.resolve(
        __dirname, '../../../../../fengyu-staff/cloudfunctions/staffApi/routes/order.js',
      )
      const SET_LITERAL = /\[\s*'待支付',\s*'支付失败'\s*\]/
      expect(read(CLIENT_ORDER)).toMatch(SET_LITERAL)
      expect(read(STAFF_ORDER)).toMatch(SET_LITERAL)
      expect(read(ADMIN_ORDERS)).toMatch(SET_LITERAL)
      // 三端都应通过具名常量引用，而不是散落字面量
      expect(read(CLIENT_ORDER)).toContain('CLOSEABLE_ORDER_STATUSES')
      expect(read(STAFF_ORDER)).toContain('CLOSEABLE_ORDER_STATUSES')
      expect(read(ADMIN_ORDERS)).toContain('CLOSEABLE_ORDER_STATUSES')
    })

    // fail-closed 是整个关单流程的承重结构：关单返回成功 ≠ 渠道已终态，
    // 必须复核；复核不过一律不释放本地意图。两份 helper 都不许绕过。
    test('clientApi 与 admin 的作废 helper 都保留「关单后复核」结构', () => {
      for (const file of [CLIENT_ORDER, ADMIN_ORDERS]) {
        const src = read(file)
        expect(src).toContain('closeTrade')
        // 关单之后必须再查一次
        expect(src).toMatch(/closeTrade[\s\S]{0,1200}queryTrade/)
        // 释放意图的 CAS 必须锚当前单号
        expect(src).toMatch(/lakala_out_order_no = (\$2|\$\{outTradeNo\})/)
      }
    })
  })
})
