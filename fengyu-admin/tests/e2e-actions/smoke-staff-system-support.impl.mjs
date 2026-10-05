import assert from 'node:assert/strict'
import '../../../fengyu-staff/tests/e2e-cloudfn/setup.mjs'
process.env.DATABASE_URL = process.env.PG_CONNECTION_STRING
process.env.E2E_DATABASE_URL = process.env.PG_CONNECTION_STRING
const { runSystemSupport } = await import('../../../fengyu-staff/tests/e2e-cloudfn/smoke-staff-system-support.mjs')
const { TEST_STORE_ID, TEST_CLIENT_USER_ID, NS } = await import('../../../fengyu-staff/tests/e2e-cloudfn/setup.mjs')
const { getServiceStaffCandidates, getAllocationEmployeeCandidates } = await import('../../src/actions/employees.ts')
const { batchSaveServiceCommissions } = await import('../../src/actions/service-commissions.ts')
const { savePaymentAllocations } = await import('../../src/actions/allocations.ts')
const { createServiceOrder } = await import('../../src/actions/services.ts')
const { shanghaiToday } = await import('../../src/lib/datetime.ts')
const create = (employeeId, saleItemId) => createServiceOrder({ storeId: TEST_STORE_ID, marketName: `${NS}_市场`,
  clientUserId: TEST_CLIENT_USER_ID, assignedEmployeeId: employeeId, serviceDate: shanghaiToday(), items: [{ saleItemId, sessionUsed: 1 }] })
await runSystemSupport({
  async createService(employeeId, saleItemId) {
    const result = await create(employeeId, saleItemId)
    assert.equal(result.success, true, result.message)
    return result
  },
  async rejectService(employeeId, saleItemId) {
    assert.equal((await create(employeeId, saleItemId)).success, false)
  },
  async rejectAllocations(serviceOrderId, serviceItemId, salePaymentId, saleItemId, employeeId) {
    assert.equal((await batchSaveServiceCommissions(serviceOrderId, [{ serviceItemId, employeeId, roleType: '品项老师', allocationRatio: 1 }])).success, false)
    assert.equal((await savePaymentAllocations(salePaymentId, [{ saleItemId, employeeId, roleType: '品项老师', allocationRatio: 1 }])).success, false)
  },
  async rejectRevenueSkill(id, allocations) {
    assert.equal((await savePaymentAllocations(id, allocations)).success, false)
  },
  async rejectSkill(id, commissions) {
    assert.equal((await batchSaveServiceCommissions(id, commissions)).success, false)
  },
  async checkCandidates(expected) {
    for (const getCandidates of [getServiceStaffCandidates, getAllocationEmployeeCandidates]) {
      const candidates = await getCandidates(TEST_STORE_ID)
      for (const person of expected) assert.equal(candidates.find(c => c.employeeId === person.id)?.assignmentScope, person.scope)
      const firstTrip = candidates.findIndex(c => c.assignmentScope !== 'local')
      assert(candidates.slice(firstTrip).every(c => c.assignmentScope !== 'local'))
      for (const c of candidates) assert(!('phone' in c) && !('idCard' in c))
    }
  },
  async saveService(id, commissions) {
    const result = await batchSaveServiceCommissions(id, commissions)
    assert.equal(result.success, true, result.message)
  },
  async saveRevenue(id, allocations) {
    const result = await savePaymentAllocations(id, allocations)
    assert.equal(result.success, true, result.message)
  },
})

process.exit(0)
