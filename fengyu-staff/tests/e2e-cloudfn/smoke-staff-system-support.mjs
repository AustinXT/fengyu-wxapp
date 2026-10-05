#!/usr/bin/env bun
/** #530：真实 PG 两端三入口，全系统四技能支援与推广回显。 */
import './setup.mjs'
import assert from 'node:assert/strict'
import { NS, TEST_STORE_ID, TEST_STORE_ORG_ID, TEST_MARKET_ORG_ID, TEST_STORES_MULTI,
  TEST_CLIENT_USER_ID, TEST_MANAGER_OPENID, TEST_MANAGER_EMP_ID, pgQuery, closePool, testPhone } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { cleanupTestData, ensureTestStore, createTestOrg, createTestStaff, createTestClient,
  createTestProduct, createTestSaleOrder } from './helpers/fixtures.mjs'

export async function runSystemSupport(admin = null) {
  const roles = ['店经理', '美容师', '养生师', '品项老师']
  const people = []
  const invoke = async (action, payload = {}) => {
    const response = await invokeStaffApi(action, { _testOpenid: TEST_MANAGER_OPENID, ...payload })
    assert.equal(response.code, 0, `${action}: ${response.message}`)
    return response.data
  }
  try {
    await cleanupTestData(NS)
    await ensureTestStore()
    await createTestOrg()
    await createTestStaff()
    await createTestClient()
    const locations = [
      { scope: 'local', storeId: TEST_STORE_ID, orgNodeId: TEST_STORE_ORG_ID, trip: false },
      { scope: 'same_market_trip', storeId: null, orgNodeId: TEST_MARKET_ORG_ID, trip: true },
      { scope: 'cross_market_trip', storeId: TEST_STORES_MULTI.B1.storeId, orgNodeId: TEST_STORES_MULTI.B1.orgId, trip: true },
      { scope: 'cross_market_trip', storeId: null, orgNodeId: null, trip: true },
    ]
    for (const [r, role] of [...roles, '推广师'].entries()) {
      for (const [l, location] of locations.entries()) {
        const id = `${NS}_530_E${r}${l}`
        await createTestStaff({ employeeId: id, openid: `${NS}_530_O${r}${l}`, phone: testPhone(20 + r * 4 + l),
          name: `${NS}_${role}_${l}`, isManager: false, skills: [role], ...location })
        await pgQuery('UPDATE staff_wechat_users SET is_on_business_trip = $2 WHERE employee_id = $1', [id, location.trip])
        people.push({ id, role, ...location })
      }
    }
    // 非本店未开支援 / 离职 / 技能不符均不得进入服务候选或直接创建。
    const invalid = []
    for (const [index, resigned] of [false, true].entries()) {
      const id = `${NS}_530_BAD${index}`
      await createTestStaff({ employeeId: id, openid: `${id}_OPENID`, phone: testPhone(60 + index),
        name: id, isManager: false, skills: ['品项老师'],
        storeId: TEST_STORES_MULTI.B1.storeId, orgNodeId: TEST_STORES_MULTI.B1.orgId })
      await pgQuery('UPDATE staff_wechat_users SET is_on_business_trip = $2, is_resigned = $3 WHERE employee_id = $1',
        [id, resigned, resigned])
      invalid.push(id)
    }
    // 第三人活跃且已支援，但只具备推广技能；独立验证服务技能门控。
    invalid.push(people[17].id)
    const list = (await invoke('staff.list', { scene: 'service', storeId: TEST_STORE_ID })).staffList
    const expected = people.filter(p => roles.includes(p.role))
    for (const person of expected) assert.equal(list.find(p => p.staffWfId === person.id)?.assignmentScope, person.scope)
    assert.equal(list.filter(p => p.staffWfId.startsWith(`${NS}_530`)).length, 16)
    const firstTrip = list.findIndex(p => p.assignmentScope !== 'local')
    assert(list.slice(firstTrip).every(p => p.assignmentScope !== 'local'), '本店整体在支援之前')
    for (const id of invalid) assert(!list.some(p => p.staffWfId === id))
    if (admin) await admin.checkCandidates(expected)

    const { skuId } = await createTestProduct({ suffix: '530', sessionCount: 30 })
    const saleOrderId = `${NS}_530_SO`
    const { saleItemId } = await createTestSaleOrder({ saleOrderId, clientUserId: TEST_CLIENT_USER_ID,
      skuId, sessionCount: 30, totalAmount: 3000, status: '已支付', salesCategory: '自销自耗' })
    let serviceOrderId
    for (const person of expected) {
      const result = admin
        ? await admin.createService(person.id, saleItemId)
        : await invoke('service.create', { clientUserId: TEST_CLIENT_USER_ID,
          assignedStaffWfId: person.id, items: [{ saleItemId, employeeId: person.id, sessionUsed: 1 }] })
      serviceOrderId = result.serviceOrderId
      await pgQuery("UPDATE service_orders SET status = '已取消' WHERE service_order_id = $1", [serviceOrderId])
    }
    for (const id of invalid) {
      if (admin) await admin.rejectService(id, saleItemId)
      const response = await invokeStaffApi('service.create', { _testOpenid: TEST_MANAGER_OPENID,
        clientUserId: TEST_CLIENT_USER_ID, assignedStaffWfId: id, items: [{ saleItemId, employeeId: id, sessionUsed: 1 }] })
      assert.equal(response.code, -400, `非法人员 ${id} 应拒绝`)
    }
    // 最后一条走既有完成/确认流程，身份不能兜底为美容师。
    await pgQuery("UPDATE service_orders SET status = '服务中' WHERE service_order_id = $1", [serviceOrderId])
    await invoke('service.complete', { serviceOrderId })
    await invoke('service.confirm', { serviceOrderId })
    const detail = await invoke('serviceCommission.detail', { serviceOrderId })
    assert.equal(detail.commissions[0].role_type, '品项老师')
    for (const person of expected) assert(detail.candidateEmployees.some(p => p.staffWfId === person.id))
    const serviceItemId = detail.items[0].service_item_id
    const teacherId = expected.find(p => p.role === '品项老师').id
    const spoof = [{ serviceItemId, employeeId: teacherId, roleType: '美容师', allocationRatio: 1 }]
    const spoofResponse = await invokeStaffApi('serviceCommission.save', { _testOpenid: TEST_MANAGER_OPENID, serviceOrderId, commissions: spoof })
    assert.equal(spoofResponse.code, -400, '品项老师不得伪造美容师角色')
    if (admin) await admin.rejectSkill(serviceOrderId, spoof)
    const commissions = expected.filter(p => p.storeId === TEST_STORE_ID || (p.storeId === null && p.orgNodeId === null))
      .map(p => ({ serviceItemId, employeeId: p.id, roleType: p.role, allocationRatio: 0.5 }))
    if (admin) await admin.saveService(serviceOrderId, commissions)
    else await invoke('serviceCommission.save', { serviceOrderId, commissions })
    const restored = await invoke('serviceCommission.detail', { serviceOrderId })
    assert.equal(restored.commissions.length, 8)
    for (const c of commissions) assert(restored.commissions.some(row => row.employee_id === c.employeeId && row.role_type === c.roleType))

    const [{ id: salePaymentId }] = await pgQuery(`INSERT INTO sale_order_payments
      (sale_order_id, change_type, amount, payment_method, status, source_end, operator_employee_id, paid_at, allocation_status)
      VALUES ($1, '首次支付', 3000, '线下', '已支付', 'staff', $2, NOW(), '待分配') RETURNING id`, [saleOrderId, TEST_MANAGER_EMP_ID])
    await pgQuery(`INSERT INTO sale_payment_item_receipts (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category)
      VALUES ($1, $2, $3, 3000, '自销自耗')`, [salePaymentId, saleOrderId, saleItemId])
    const suggest = await invoke('allocation.suggestPayment', { salePaymentId })
    for (const person of expected) assert(suggest.candidateEmployees.some(p => p.staffWfId === person.id))
    const spoofRevenue = [{ saleItemId, employeeId: teacherId, roleType: '美容师', allocationRatio: 1 }]
    const spoofRevenueResponse = await invokeStaffApi('allocation.savePayment', { _testOpenid: TEST_MANAGER_OPENID, salePaymentId, allocations: spoofRevenue })
    assert.equal(spoofRevenueResponse.code, -400, '营业额分配也不得伪造角色技能')
    if (admin) await admin.rejectRevenueSkill(Number(salePaymentId), spoofRevenue)
    const allocations = people.filter(p => p.storeId === TEST_STORE_ID || (p.storeId === null && p.orgNodeId === TEST_MARKET_ORG_ID))
      .map(p => ({ saleItemId, employeeId: p.id, roleType: p.role, allocationRatio: 0.5 }))
    if (admin) await admin.saveRevenue(Number(salePaymentId), allocations)
    else await invoke('allocation.savePayment', { salePaymentId, allocations })
    const reloaded = await invoke('allocation.suggestPayment', { salePaymentId })
    assert.equal(reloaded.existingAllocations.length, 10)
    for (const a of allocations) assert(reloaded.existingAllocations.some(row => row.employee_id === a.employeeId && row.role_type === a.roleType))
    for (const id of invalid.slice(0, 2)) {
      if (admin) await admin.rejectAllocations(serviceOrderId, serviceItemId, Number(salePaymentId), saleItemId, id)
      const badService = await invokeStaffApi('serviceCommission.save', { _testOpenid: TEST_MANAGER_OPENID,
        serviceOrderId, commissions: [{ serviceItemId, employeeId: id, roleType: '品项老师', allocationRatio: 1 }] })
      assert.equal(badService.code, -400)
      const badRevenue = await invokeStaffApi('allocation.savePayment', { _testOpenid: TEST_MANAGER_OPENID,
        salePaymentId, allocations: [{ saleItemId, employeeId: id, roleType: '品项老师', allocationRatio: 1 }] })
      assert.equal(badRevenue.code, -400)
    }
    console.log(`[system-support] ${admin ? 'admin' : 'staff'} PASS: 全系统四技能、本店置顶、三入口保存回显、推广与非法员工拒绝`)
  } finally {
    await cleanupTestData(NS)
    await closePool()
  }
}

if (import.meta.main) await runSystemSupport()
