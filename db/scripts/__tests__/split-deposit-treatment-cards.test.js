'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildTreatmentCardAllocationPlan } = require('../split-deposit-treatment-cards')

function inspected({ remaining, services = [], children = [] }) {
  return {
    source: {
      sale_item_id: 'SOURCE',
      session_count: 10,
      remaining_sessions: remaining,
    },
    perCardSessions: 5,
    services,
    children,
  }
}

test('转换已先消耗首张卡时，余额与转出记录绑定同一张子卡', () => {
  const plan = buildTreatmentCardAllocationPlan(inspected({
    remaining: 5,
    children: [{
      sale_item_id: 'CONVERSION-1',
      quantity: 5,
      child_order_status: '已支付',
      created_at: '2026-08-01T10:00:00.000Z',
    }],
  }), ['SOURCE', 'CARD-2'])

  assert.deepEqual(plan.remaining, [0, 5])
  assert.deepEqual(plan.childChunks.get('CONVERSION-1'), [{ saleItemId: 'SOURCE', quantity: 5 }])
})

test('服务核销与转换按同一时间线分配，后发生的核销不会重新占用首张卡', () => {
  const plan = buildTreatmentCardAllocationPlan(inspected({
    remaining: 3,
    children: [{
      sale_item_id: 'CONVERSION-1',
      quantity: 5,
      child_order_status: '已支付',
      created_at: '2026-08-01T10:00:00.000Z',
    }],
    services: [{
      service_item_id: 'SERVICE-1',
      session_used: 2,
      service_status: '已完成',
      service_completed_at: '2026-08-02T10:00:00.000Z',
      created_at: '2026-08-01T09:00:00.000Z',
    }],
  }), ['SOURCE', 'CARD-2'])

  assert.deepEqual(plan.remaining, [0, 3])
  assert.deepEqual(plan.childChunks.get('CONVERSION-1'), [{ saleItemId: 'SOURCE', quantity: 5 }])
  assert.deepEqual(plan.serviceChunks.get('SERVICE-1'), [{ saleItemId: 'CARD-2', quantity: 2 }])
})

test('历史消耗与聚合余额不一致时拒绝拆分', () => {
  assert.throws(
    () => buildTreatmentCardAllocationPlan(inspected({
      remaining: 5,
      children: [{
        sale_item_id: 'CONVERSION-1',
        quantity: 4,
        child_order_status: '已支付',
        created_at: '2026-08-01T10:00:00.000Z',
      }],
    }), ['SOURCE', 'CARD-2']),
    /HISTORY_CONSUMPTION_MISMATCH/,
  )
})
