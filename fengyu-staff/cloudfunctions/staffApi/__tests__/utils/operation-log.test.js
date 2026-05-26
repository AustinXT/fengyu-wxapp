/**
 * operation-log.js helper 行为单测。
 * 验证：operator 字段装填、SAVEPOINT 隔离序列、PII 脱敏、computeChanges、logUpdate/logTransition 结构。
 */
const {
  logOperation,
  logUpdate,
  logTransition,
  computeChanges,
} = require('../../utils/operation-log')

/**
 * 构造记录调用的 mock 事务 client。
 * @param {(sql:string, params:any[]) => boolean} failOn 命中则该 query 抛错（模拟 INSERT 失败）
 */
function makeClient(failOn) {
  const calls = []
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })
      if (failOn && failOn(sql, params)) {
        throw new Error('simulated INSERT failure')
      }
      return { rows: [] }
    },
  }
}

const baseCtx = {
  auth: {
    staffWfId: 'E001',
    name: '张三',
    roles: ['manager'],
    roleBindings: [
      { role: 'manager', scopeId: 'node-1', scopeType: '门店', scopeName: '中心店' },
    ],
  },
}

describe('logOperation', () => {
  test('装填 operator 字段 + scope + source=staffApi', async () => {
    const client = makeClient()
    await logOperation(client, baseCtx, 'order.create', 'sale_order', 'FY-1', { foo: 'bar' })

    // SAVEPOINT → INSERT → RELEASE 三步序列
    expect(client.calls[0].sql).toBe('SAVEPOINT op_log')
    expect(client.calls[1].sql).toContain('INSERT INTO operation_logs')
    expect(client.calls[1].sql).toContain("'staffApi'")
    expect(client.calls[2].sql).toBe('RELEASE SAVEPOINT op_log')

    const p = client.calls[1].params
    expect(p[0]).toBe('E001')        // operator_employee_id
    expect(p[1]).toBe('张三')         // operator_name
    expect(p[2]).toBe('manager')     // operator_role
    expect(p[3]).toBe('node-1')      // org_node_id
    expect(p[4]).toBe('中心店')       // org_node_name
    expect(p[5]).toBe('order.create')
    expect(p[6]).toBe('sale_order')
    expect(p[7]).toBe('FY-1')        // String(targetId)
    expect(JSON.parse(p[8])).toEqual({ foo: 'bar' })
  })

  test('targetId 强转字符串', async () => {
    const client = makeClient()
    await logOperation(client, baseCtx, 'card.createRefund', 'sale_order_payment', 123, null)
    expect(client.calls[1].params[7]).toBe('123')
    expect(client.calls[1].params[8]).toBeNull()
  })

  test('detail 中 PII 字段入库前脱敏', async () => {
    const client = makeClient()
    await logOperation(client, baseCtx, 'x.y', 't', '1', { phone: '13812345678', note: 'ok' })
    const detail = JSON.parse(client.calls[1].params[8])
    expect(detail.phone).toBe('138****5678')
    expect(detail.note).toBe('ok')
  })

  test('INSERT 失败时 ROLLBACK TO SAVEPOINT 且不抛错（业务不受影响）', async () => {
    const client = makeClient((sql) => sql.includes('INSERT INTO operation_logs'))
    await expect(
      logOperation(client, baseCtx, 'order.create', 'sale_order', 'FY-1', { a: 1 })
    ).resolves.toBeUndefined()
    const sqls = client.calls.map((c) => c.sql)
    expect(sqls).toContain('ROLLBACK TO SAVEPOINT op_log')
  })

  test('roleBindings 缺失时退化用 roles[0]，org 字段为 null', async () => {
    const client = makeClient()
    const ctx = { auth: { staffWfId: 'E002', name: '李四', roles: ['beautician'], roleBindings: [] } }
    await logOperation(client, ctx, 'a.b', 't', '1')
    const p = client.calls[1].params
    expect(p[2]).toBe('beautician')
    expect(p[3]).toBeNull()
    expect(p[4]).toBeNull()
  })
})

describe('computeChanges', () => {
  test('无变更返回 null', () => {
    expect(computeChanges({ a: 1, b: 2 }, { a: 1 })).toBeNull()
  })
  test('仅遍历 after 的 key，返回 from/to', () => {
    expect(computeChanges({ a: 1, b: 9 }, { a: 2 })).toEqual({ a: { from: 1, to: 2 } })
  })
  test('from 为 undefined 归一化成 null', () => {
    expect(computeChanges({}, { a: 'x' })).toEqual({ a: { from: null, to: 'x' } })
  })
})

describe('logUpdate', () => {
  test('无变更不写日志', async () => {
    const client = makeClient()
    await logUpdate(client, baseCtx, 'customer.update', 'customer', '1', { a: 1 }, { a: 1 })
    expect(client.calls.length).toBe(0)
  })
  test('有变更写 _v:3 _t:update + changes', async () => {
    const client = makeClient()
    await logUpdate(client, baseCtx, 'customer.update', 'customer', '1', { a: 1 }, { a: 2 })
    const detail = JSON.parse(client.calls[1].params[8])
    expect(detail._v).toBe(3)
    expect(detail._t).toBe('update')
    expect(detail.changes).toEqual({ a: { from: 1, to: 2 } })
  })
})

describe('logTransition', () => {
  test('写 _v:3 _t:transition + from/to', async () => {
    const client = makeClient()
    await logTransition(client, baseCtx, 'order.close', 'sale_order', 'FY-1', '待支付', '已关闭')
    const detail = JSON.parse(client.calls[1].params[8])
    expect(detail).toEqual({ _v: 3, _t: 'transition', from: '待支付', to: '已关闭' })
  })
  test('携带 context', async () => {
    const client = makeClient()
    await logTransition(client, baseCtx, 'order.close', 'sale_order', 'FY-1', '待支付', '已关闭', { amount: 100 })
    const detail = JSON.parse(client.calls[1].params[8])
    expect(detail.context).toEqual({ amount: 100 })
  })
})
