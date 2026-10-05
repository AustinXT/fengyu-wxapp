const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWorkspaces, managerViewStores } = require('../utils/daily-workspaces');

test('店员只看到员工工作台', () => {
  assert.deepEqual(resolveWorkspaces([], [{ scopeType: '门店', actions: ['report:write'] }]).availableWorkspaces, ['employee']);
});

test('门店店长看到员工和店长工作台，门店数据权限不额外开放管理层', () => {
  const result = resolveWorkspaces([{ store_id: 'S1' }], [{ scopeType: '门店', actions: ['data_center:dashboard'] }]);
  assert.deepEqual(result.availableWorkspaces, ['employee', 'manager']);
  assert.equal(result.management, false);
});

test('市场或总部管理者看到三个工作台，并可在店长视图按管理范围查看门店', () => {
  const scopedStores = [{ store_id: 'S1' }, { store_id: 'S2' }];
  const result = resolveWorkspaces([], [{ scopeType: '市场', actions: ['data_center:dashboard'] }]);
  assert.deepEqual(result.availableWorkspaces, ['employee', 'manager', 'management']);
  assert.deepEqual(managerViewStores([], scopedStores, result.management), scopedStores);
  assert.deepEqual(managerViewStores([{ store_id: 'M1' }], scopedStores, result.management), [{ store_id: 'M1' }]);
});

test('仅有市场范围但没有数据看板权限时不开放管理层工作台', () => {
  assert.deepEqual(resolveWorkspaces([], [{ scopeType: '市场', actions: ['employee:list'] }]).availableWorkspaces, ['employee']);
});
