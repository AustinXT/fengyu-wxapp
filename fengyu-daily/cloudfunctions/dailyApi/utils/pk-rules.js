function validateClasses(classes) {
  if (!Array.isArray(classes)) throw Error('INVALID_PARAMS: 无效PK班级配置');
  const ids = new Set(), names = new Set(), stores = new Set();
  for (const item of classes) {
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
        !name || name.length > 30 || names.has(name) || !Array.isArray(item.storeIds))
      throw Error('INVALID_PARAMS: 班级编号和名称需有效且不能重复');
    ids.add(item.id); names.add(name);
    for (const storeId of item.storeIds) {
      if (typeof storeId !== 'string' || !storeId || stores.has(storeId))
        throw Error('INVALID_PARAMS: 同一经营月每家门店只能参加一个班级');
      stores.add(storeId);
    }
  }
  return classes.map((item) => ({ ...item, name: item.name.trim(), storeIds: [...item.storeIds] }));
}

// 沿用原型的周完成率降序：无目标或零目标置后，同率保持输入顺序。
// 用整数交叉乘法比较，避免浮点近似改变排名。
function rankRows(rows, metric) {
  if (!['sales', 'consumption', 'visits', 'newCustomers', 'projects'].includes(metric) || !Array.isArray(rows))
    throw Error('INVALID_PARAMS: 无效PK指标');
  const items = rows.map((row, index) => {
    const values = row[metric];
    if (!values || !Number.isSafeInteger(values.weekDone) ||
        (values.weekTarget !== null && (!Number.isSafeInteger(values.weekTarget) || values.weekTarget < 0)))
      throw Error('INVALID_PARAMS: 无效PK目标或完成金额');
    return { row, index, values };
  });
  items.sort((a, b) => {
    const activeA = a.values.weekTarget > 0, activeB = b.values.weekTarget > 0;
    if (activeA !== activeB) return activeA ? -1 : 1;
    if (activeA) {
      const left = BigInt(a.values.weekDone) * BigInt(b.values.weekTarget);
      const right = BigInt(b.values.weekDone) * BigInt(a.values.weekTarget);
      if (left !== right) return left > right ? -1 : 1;
    }
    return a.index - b.index;
  });
  return items.map(({ row }, index) => ({ ...row, rank: index + 1 }));
}

module.exports = { validateClasses, rankRows };
