# Ticket-10b: admin lib/* 2 处 cloudbase 裸 throw 收敛到 ApiError

> 生成日期：2026-05-17
> 实施状态：⚪ 未开工
> 严重级别：**P2**（Server Action 调用 cloudbase upload/reupload 失败时，原样裸抛冒泡命中 `runWithApiResponse` 的"非白名单 → 服务器内部错误"兜底，吞掉真实失败原因）
> 端：fengyu-admin
> 修复成本：**XS**（10 分钟 — 2 处单行替换 + import ApiError）
> 来源：[主 ticket §1.2 拆出的 follow-up](2026-05-17-error-code-prefix-whitelist-and-admin-throw.md)

---

## 0 一句话背景

主 ticket 完成 9 项错误前缀白名单 + `ApiError` + `runWithApiResponse` HOF 后，admin `src/actions/*` 范围已基本规范化（剩 33 处由 ticket-10c 收尾），但 `src/lib/*` 仍有 2 处 cloudbase 上传/下载裸 throw 未带前缀。Server Action 调 lib 时这些原样冒泡到 `runWithApiResponse`，命中"非白名单 → `{code:-1, errorType:null, message:'服务器内部错误'}`"兜底，**吞掉真实失败原因**（如上传失败 / CDN 拉取 4xx/5xx），导致前端无法区分。

---

## 1 现状（grep 实证 2026-05-17）

```bash
grep -rn "throw new Error" fengyu-admin/src/lib/ \
  | grep -vE "__tests__|\.test\.ts" \
  | grep -vE "throw new Error\(['\"\`]?(UNAUTHORIZED|PHONE_REQUIRED|INVALID_PARAMS|PERMISSION_DENIED|NOT_FOUND|INSUFFICIENT_BALANCE|CONFLICT|INVALID_STATE|CLIENT_NOT_REGISTERED):"
```

**3 行命中，其中 1 行为 grep 假阳性**：

| 文件:行 | 当前抛错 | 是否真实违规 |
|---------|---------|------------|
| `fengyu-admin/src/lib/refund.ts:93` | `throw new Error(` 后跟 line 94 ``INVALID_STATE: 明细 ${req.saleItemId} 可退数量 ${maxUnused} 不足 ${requested}` `` | ❌ 假阳性（多行 throw，前缀在下一行） |
| `fengyu-admin/src/lib/cloudbase.ts:29` | `throw new Error("上传失败")` | ✅ 真实违规 |
| `fengyu-admin/src/lib/cloudbase.ts:56` | `` throw new Error(`Failed to download ${cleanUrl}: ${res.status}`) `` | ✅ 真实违规 |

实际需迁移：**2 处**（cloudbase.ts:29 + cloudbase.ts:56）。

> 主 ticket §1.2 估计的"11 处"是基于早期快照，commit `711d7cc` 之前已经迁了大部分。当前实证以本 ticket 为准。

---

## 2 迁移设计

### 2.1 cloudbase.ts:29 — 上传失败

**当前**：
```ts
if (!result.fileID) {
  throw new Error("上传失败")
}
```

**改为**：
```ts
import { ApiError } from '@/lib/api-error'
// ...
if (!result.fileID) {
  throw new ApiError('INVALID_STATE', '文件上传失败，请重试')
}
```

**理由**：上传失败属于状态机阻塞（CloudBase 调用未抛但 fileID 缺失，通常是临时故障），前端按 `errorType === 'INVALID_STATE'` 提示用户重试。

### 2.2 cloudbase.ts:56 — CDN 下载失败

**当前**：
```ts
if (!res.ok) throw new Error(`Failed to download ${cleanUrl}: ${res.status}`)
```

**改为**：
```ts
if (!res.ok) throw new ApiError('INVALID_STATE', `资源下载失败 (HTTP ${res.status})`)
```

**理由**：CDN 拉取 4xx/5xx 同属临时性外部依赖故障；URL 不放进消息（避免泄露 cloudbase 内部路径给前端）；status code 保留供前端日志归类。

### 2.3 refund.ts:93 — 不动

多行 throw 已含 `INVALID_STATE:` 前缀，仅是 grep 行级匹配看不到。**保持不变**。
可考虑把 throw 合并到单行：
```ts
if (requested > maxUnused) {
  throw new Error(`INVALID_STATE: 明细 ${req.saleItemId} 可退数量 ${maxUnused} 不足 ${requested}`)
}
```
让 grep 守护脚本不再误报（**可选**，本 ticket 不强制）。

---

## 3 验证

### 3.1 单元测试
```bash
cd fengyu-admin && bun run test src/actions/refunds.test.ts
# 预期：全绿（cloudbase.ts 不直接被 refunds.ts 调用；改动仅影响上传/下载路径）
```

### 3.2 grep 反向断言（更新基线）

主 ticket 的 snapshot 测试 `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js` 当前只守护 `actions/`（基线 33）。
**本 ticket 完成后**：可在该测试新增 `lib/` 反向断言（基线 0），命令同结构：
```bash
grep -rn "throw new Error" fengyu-admin/src/lib/ \
  | grep -vE "__tests__|\.test\.ts" \
  | grep -vE "throw new Error\(['\"\`]?(<9项>):"
# 预期 stdout 为空（refund.ts:93 假阳性可忽略或合并到单行消除）
```

### 3.3 手测
admin "员工头像上传" / "商品图重传" 路径触发失败时，前端应能看到 `INVALID_STATE: 文件上传失败，请重试` 文案（不是"服务器内部错误"）。

---

## 4 风险

- **极低**：cloudbase 上传是 admin 内部工具方法，不参与生产 happy path。
- 改动后 `runWithApiResponse` 把 ApiError 序列化为 `{success:false, code:-400, errorType:'INVALID_STATE', message:'文件上传失败，请重试'}`，与 Server Action 当前返回 shape 兼容。
- 若 Server Action 仍用 try/catch 自接，需要把 `ApiError` 实例的 `.prefix` / `.message` 字段直接序列化回 `{success:false, message:err.message}` —— 与现有写法不冲突。

---

## 5 关联

| 项 | 说明 |
|----|------|
| **主 ticket** | [2026-05-17-error-code-prefix-whitelist-and-admin-throw.md](2026-05-17-error-code-prefix-whitelist-and-admin-throw.md) §1.2 拆出 |
| **配套 follow-up** | [ticket-10c admin actions/* 33 处批量替换](2026-05-17-admin-actions-throw-batch-migration.md) |
| **依赖** | `fengyu-admin/src/lib/api-error.ts`（`ApiError` class + 9 项白名单，已就位） |
| **不依赖** | ticket-10d (with-permission 迁移补齐) — 路径完全无重叠，可并行 |
