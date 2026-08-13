'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildGroupRepairPlan,
  conversionConsumesSource,
  findMismatchedGroupIds,
  sortCards,
} = require('../repair-split-treatment-card-integrity')

function card(id, remaining = 1, paid = 1) {
  return {
    sale_item_id: id,
    session_count: 1,
    remaining_sessions: remaining,
    paid_sessions: paid,
  }
}

test('按拆卡记录顺序重放已完成服务与有效转换并重算单卡余额', () => {
  const cards = sortCards(
    [card('CARD-3', 0), card('SOURCE', 1), card('CARD-2', 1)],
    ['SOURCE', 'CARD-2', 'CARD-3'],
    'SOURCE',
  )
  const plan = buildGroupRepairPlan({
    cards,
    services: [{
      service_item_id: 'SERVICE-1',
      sale_item_id: 'CARD-2',
      session_used: 1,
      service_status: '已完成',
      completed_at: '2026-08-01T10:00:00Z',
      created_at: '2026-08-01T09:00:00Z',
    }],
    children: [{
      sale_item_id: 'CONVERSION-1',
      ref_sale_item_id: 'CARD-3',
      quantity: -1,
      child_order_status: '已支付',
      created_at: '2026-08-02T10:00:00Z',
    }],
  })

  assert.equal(plan.serviceTargets.get('SERVICE-1'), 'SOURCE')
  assert.equal(plan.conversionTargets.get('CONVERSION-1'), 'CARD-2')
  assert.deepEqual([...plan.remainingByCardId.values()], [0, 0, 1])
})

test('已关闭转换不消费次数，待服务明细改绑到仍可用卡但不扣余额', () => {
  const plan = buildGroupRepairPlan({
    cards: [card('SOURCE', 0), card('CARD-2', 1)],
    services: [{
      service_item_id: 'PENDING-1', sale_item_id: 'SOURCE', session_used: 1,
      service_status: '待服务', created_at: '2026-08-03T10:00:00Z',
    }],
    children: [{
      sale_item_id: 'CLOSED-1', ref_sale_item_id: 'SOURCE', quantity: -1,
      child_order_status: '已关闭', created_at: '2026-08-01T10:00:00Z',
    }],
  })

  assert.equal(conversionConsumesSource({ child_order_status: '已关闭' }), false)
  assert.equal(plan.conversionTargets.has('CLOSED-1'), false)
  assert.equal(plan.serviceTargets.get('PENDING-1'), 'SOURCE')
  assert.deepEqual([...plan.remainingByCardId.values()], [1, 1])
})

test('累计有效消耗超过已付或总容量时拒绝修复', () => {
  assert.throws(() => buildGroupRepairPlan({
    cards: [card('SOURCE', 1, 0)],
    services: [{
      service_item_id: 'SERVICE-1', sale_item_id: 'SOURCE', session_used: 1,
      service_status: '已完成', completed_at: '2026-08-01T10:00:00Z',
    }],
    children: [],
  }), /EVENT_CAPACITY_OVERFLOW/)
})

test('余额已一致时仍将待服务从耗尽卡改绑到可用卡', () => {
  const plan = buildGroupRepairPlan({
    cards: [card('SOURCE', 0), card('CARD-2', 1)],
    services: [
      {
        service_item_id: 'COMPLETED-1', sale_item_id: 'SOURCE', session_used: 1,
        service_status: '已完成', completed_at: '2026-08-01T10:00:00Z',
      },
      {
        service_item_id: 'PENDING-1', sale_item_id: 'SOURCE', session_used: 1,
        service_status: '待服务', created_at: '2026-08-02T10:00:00Z',
      },
    ],
    children: [],
  })

  assert.equal(plan.serviceTargets.get('COMPLETED-1'), 'SOURCE')
  assert.equal(plan.serviceTargets.get('PENDING-1'), 'CARD-2')
  assert.deepEqual([...plan.remainingByCardId.values()], [0, 1])
})

test('自动候选包含余额一致但待服务仍引用不可用卡的分组', async () => {
  const client = {
    query: async (sql, params) => {
      assert.match(sql, /pending_order\.status = '待服务'/)
      assert.match(sql, /referenced_card\.remaining_sessions/)
      assert.match(sql, /referenced_card\.paid_sessions/)
      assert.deepEqual(params, [25])
      return { rows: [{ group_id: 'GROUP-PENDING' }] }
    },
  }

  const groupIds = await findMismatchedGroupIds(client, [], 25)
  assert.deepEqual(groupIds, ['GROUP-PENDING'])
})

test('显式指定分组绕过自动候选条件', async () => {
  const client = {
    query: async (sql, params) => {
      assert.match(sql, /split\.group_id = ANY\(\$1\)/)
      assert.match(sql, /HAVING TRUE/)
      assert.doesNotMatch(sql, /pending_order\.status = '待服务'/)
      assert.deepEqual(params, [['GROUP-EXPLICIT'], 10])
      return { rows: [{ group_id: 'GROUP-EXPLICIT' }] }
    },
  }

  const groupIds = await findMismatchedGroupIds(client, ['GROUP-EXPLICIT'], 10)
  assert.deepEqual(groupIds, ['GROUP-EXPLICIT'])
})
