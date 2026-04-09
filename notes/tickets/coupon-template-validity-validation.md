# Ticket: 优惠券模板有效期校验缺失 + `issueCoupon` 365 天 fallback 陷阱

> 生成日期：2026-04-10
> 关联适配计划：`notes/adapt-plans/06-coupon-model.md` §4.1.1 / §Phase 1 Step 5
> 严重级别：P0（沉默的错误默认值，销售不可见）
> 修复归属：Phase 1 独立 PR，拆两次上线

---

## 1 问题定位

| 位置 | 说明 |
|---|---|
| `fengyu-admin/src/actions/coupons.ts:205-278` | `createTemplate` 未校验 validDays/validFrom/validTo |
| `fengyu-admin/src/actions/coupons.ts:280-341` | `updateTemplate` partial update 无一致性校验 |
| `fengyu-admin/src/actions/coupons.ts:424-434` | `issueCoupon` fallback 默认 365 天 |
| `fengyu-admin/src/actions/coupons.ts:559-569` | `batchIssueCoupons` 同 fallback |
| `fengyu-admin/src/app/(main)/coupons/_components/coupon-create-page.tsx:52-74` | 前端只校验 name/couponType/discountValue |

## 2 失控路径

```
admin UI 漏填 validDays / validTo
  → 前端 handleCreate 只校验 name/type/discountValue，放行
  → createTemplate 只校验 discountValue 与顺序，落库 validDays=NULL
  → issueCoupon: days 分支 skip → fixed 分支 skip → fallback: now + 365
  → 顾客收到一张 1 年有效的券（销售原以为是 30 天活动券）
```

fallback 的存在让所有上游漏洞都变成"静默通过 + 意外默认"，是掩盖 Bug 的反模式。

## 3 校验缺口矩阵

| 校验项 | 前端 | createTemplate | updateTemplate |
|---|---|---|---|
| validityMode 必填 + 枚举 | ✅ 默认 days | ❌ optional | ❌ 未校验 |
| days: validDays 必填 | ❌ | ❌ | ❌ |
| days: validDays 正整数 | ⚠️ parseInt 无下限 | ❌ | ❌ |
| days: validDays 上限（≤3650） | ❌ | ❌ | ❌ |
| fixed: validFrom/validTo 必填 | ❌ | ❌ | ❌ |
| fixed: validFrom < validTo | ❌ | ✅ L244 | ❌ |
| 模式 → 另一侧字段清空 | ✅ L88-90 | ❌ | ❌ |

## 4 `updateTemplate` Partial Update 3 类绕过

1. 只传 `validityMode: 'days'` 不传 `validDays` → 把 fixed 券改成"days 但无天数"脏数据
2. 只传 `validDays: null` → 把合法 days 券清空
3. 只传 `validTo` 使之早于 DB 现值 validFrom → 日期倒置不拦截

→ 修复必须以 **"DB 现值 merge 补丁后的合并状态"** 为校验基准，不能只看补丁。

---

## 5 执行方案

### 5.1 脏数据预检（上线阻塞前置）

```sql
-- 活跃脏模板：必须为 0 行后才能上线新校验
SELECT template_id, name, coupon_type, validity_mode, valid_days, valid_from, valid_to, is_active
FROM coupon_templates
WHERE is_active = true
  AND (
    validity_mode IS NULL
    OR (validity_mode = 'days'  AND valid_days IS NULL)
    OR (validity_mode = 'fixed' AND (valid_from IS NULL OR valid_to IS NULL OR valid_from >= valid_to))
  );

-- 已走过 365 fallback 的已发放券（稽核用，一般不回改 expire_at）
SELECT uc.coupon_id, uc.template_id, uc.user_id, uc.expire_at, uc.created_at
FROM user_coupons uc
JOIN coupon_templates ct ON uc.template_id = ct.template_id
WHERE ct.validity_mode IS NULL
   OR (ct.validity_mode = 'days'  AND ct.valid_days IS NULL)
   OR (ct.validity_mode = 'fixed' AND ct.valid_to IS NULL);
```

第一条命中：后台人工补填或停用，`operation_logs` 留痕。

### 5.2 `createTemplate` 后端校验补齐

签名 `validityMode?: string` → `validityMode: 'days' | 'fixed'`。在 discountValue 校验后追加：

```ts
if (data.validityMode !== 'days' && data.validityMode !== 'fixed') {
  return { success: false, message: '有效期模式必须为 days 或 fixed' }
}
if (data.validityMode === 'days') {
  const vd = Number(data.validDays)
  if (!Number.isInteger(vd) || vd <= 0) {
    return { success: false, message: '"领取后 N 天"模式需填写正整数有效天数' }
  }
  if (vd > 3650) {
    return { success: false, message: '有效天数不能超过 3650 天（10 年）' }
  }
}
if (data.validityMode === 'fixed') {
  if (!data.validFrom || !data.validTo) {
    return { success: false, message: '"固定时段"模式需同时填写开始与结束日期' }
  }
  if (new Date(data.validFrom) >= new Date(data.validTo)) {
    return { success: false, message: '有效期开始日期必须早于结束日期' }
  }
  if (new Date(data.validTo) <= new Date()) {
    return { success: false, message: '有效期结束日期必须晚于当前时间' }
  }
}
```

`insert` 时根据模式强制另一侧为 null（days → validFrom/validTo=null；fixed → validDays=null）。既有 L244 顺序校验被 fixed 分支覆盖，可删。

### 5.3 `updateTemplate` 后端校验补齐

1. 复用既有 `before` 变量（SELECT 现值）
2. 构造 `merged = { ...before, ...patch }`
3. 抽 `validateValidityFields(merged)`（复用 §5.2 校验逻辑）
4. 若 `patch.validityMode` 发生切换：
   - 切到 days → patch 必须显式含 `validDays`
   - 切到 fixed → patch 必须显式同时含 `validFrom` + `validTo`
5. 校验通过后在 `updateData` 里强制清空另一侧字段

### 5.4 消灭 `issueCoupon` / `batchIssueCoupons` fallback

```ts
let expireAt: Date
if (tpl.validityMode === 'days' && tpl.validDays) {
  expireAt = new Date()
  expireAt.setDate(expireAt.getDate() + tpl.validDays)
} else if (tpl.validityMode === 'fixed' && tpl.validTo) {
  expireAt = new Date(tpl.validTo)
} else {
  console.error('[issueCoupon] INVALID_TEMPLATE', {
    templateId: tpl.templateId, validityMode: tpl.validityMode,
    validDays: tpl.validDays, validTo: tpl.validTo,
  })
  return { success: false, message: '优惠券模板有效期配置异常，请联系管理员修复后再发放' }
}
```

`batchIssueCoupons` 同步改造，遇脏模板**整批回滚**（错误信息带 templateId）。

### 5.5 前端联动校验（`coupon-create-page.tsx` + `coupon-detail-page.tsx`）

在 `handleCreate` 现有校验链后补 days/fixed 分支校验（文案与后端**完全一致**），抽成 helper 避免两处漂移。UI 层切换 `validityMode` 时立即清空另一侧输入框（当前只在提交时 null 化）。

---

## 6 测试用例

**后端单测**（`fengyu-admin/src/actions/__tests__/coupons.test.ts`）：

- createTemplate × 8：validityMode 非法 / days 缺 validDays / days validDays ≤0 / days validDays >3650 / fixed 缺 validFrom / fixed 缺 validTo / fixed 倒置 / ✅ 合法 days + 合法 fixed（验证另一侧 null）
- updateTemplate × 5：切模式不给字段 / 清空 validDays / 倒置 validTo / 完整切模式 ✅ / 只改 name ✅
- issueCoupon × 3：✅ days 正常 / ✅ fixed 正常 / ❌ 脏数据返回 INVALID_TEMPLATE
- batchIssueCoupons × 1：脏数据整批回滚

**前端 / E2E**：days 漏填 validDays 被拦 / fixed 只填一半被拦 / 模式切换字段清空观感。

## 7 验收标准

- AC-1：UI days 漏填天数 → 前端阻止 + 后端 400（双保险）
- AC-2：UI fixed 只填一半日期 → 前端阻止 + 后端 400
- AC-3：Server Action 直接绕过前端调用，缺字段或非法 → 后端拦截，不落库
- AC-4：`updateTemplate` 恶意 partial update（切模式不给字段 / 置 null / 日期倒置）全部拦截
- AC-5：`issueCoupon` / `batchIssueCoupons` 面对脏数据 → 报错 + `console.error` 审计，**不给 365 兜底**
- AC-6：§5.1 脏数据预检 SQL 上线前执行，第一条为 0 行
- AC-7：所有新增校验有单测覆盖，`bun run test` 通过

## 8 部署顺序（关键）

1. 跑 §5.1 SQL，修完或停用脏模板
2. 发布 §5.2 + §5.3 + §5.5 前后端校验（此时 fallback 仍保留作为过渡兜底）
3. 预发/生产观察 1~3 天，定期复跑 §5.1 第一条 SQL 确认无新脏数据
4. 发布 §5.4 移除 fallback
5. **§5.2 与 §5.4 必须拆成两次上线**，降低线上风险
