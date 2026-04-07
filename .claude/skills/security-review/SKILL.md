---
name: security-review
description: |
  项目安全审查技能。检查云函数 SQL 注入、OPENID 认证、输入校验、
  权限绕过、敏感数据泄露等安全风险。特化为本项目的 CloudBase + PG 架构。
  手动触发：/security-review [scope]
argument-hint: '[审查范围，如: staffApi, clientApi, admin, 全量]'
disable-model-invocation: true
user-invocable: true
metadata:
  title: 安全审查
  description_zh: 云函数 SQL 注入 + OPENID 认证 + 输入校验 + 权限审计
  author: nvoyager
  version: 1.0.0
---

# 安全审查

对项目代码进行安全风险扫描，重点覆盖云函数和管理后台。

## 何时使用

- 发版前安全检查
- 新增 API 后的安全审计
- 用户说"安全审查"、"检查注入"、"权限审计"
- `/security-review staffApi` — 审查员工端云函数
- `/security-review clientApi` — 审查客户端云函数
- `/security-review admin` — 审查管理后台
- `/security-review 全量` — 全部审查

## 不适用

- 功能开发 → `wx-coding` / `admin-coding`
- 性能优化 → `wx-quality-assurance`
- 枚举/字段变更 → `wx-change-propagation`

---

## 1 SQL 注入检查

### 1.1 云函数（原生 pg）

**安全模式（参数化查询）：**

```javascript
// OK: $1, $2 参数占位符
await pg.query('SELECT * FROM users WHERE id = $1', [userId])
await client.query('INSERT INTO orders (id) VALUES ($1)', [orderId])
```

**危险模式（字符串拼接）：**

```javascript
// DANGER: 直接拼接用户输入
await pg.query(`SELECT * FROM users WHERE name = '${name}'`)
await pg.query('SELECT * FROM ' + tableName)
```

**扫描方法：**

```bash
# Grep 非参数化查询（在云函数路由中搜索字符串模板拼接）
grep -rn '`SELECT\|`INSERT\|`UPDATE\|`DELETE' */cloudfunctions/*/routes/*.js | grep -v '\$[0-9]'
grep -rn "pg.query.*\+" */cloudfunctions/*/routes/*.js
grep -rn "client.query.*\+" */cloudfunctions/*/routes/*.js
```

**验证**：本项目所有云函数路由应 100% 使用参数化查询。

### 1.2 管理后台（Drizzle ORM）

Drizzle 的 `eq()`, `and()` 等函数自动参数化，安全风险低。但要检查：

```bash
# 检查 raw SQL 中是否有拼接
grep -rn 'sql`' fengyu-admin/src/actions/*.ts | grep -v '\$\{' # 检查无变量注入
grep -rn 'sql\.raw' fengyu-admin/src/actions/*.ts  # sql.raw 绕过参数化
```

---

## 2 认证与授权检查

### 2.1 OPENID 认证（云函数）

**检查项：**

- [ ] auth 中间件验证 OPENID 非空：`if (!OPENID) throw new Error('UNAUTHORIZED')`
- [ ] `_testOpenid` 参数仅在开发环境生效（clientApi 已用 `ALLOW_TEST_OPENID` 环境变量控制，staffApi 需确认）
- [ ] auth 缓存 TTL 合理（当前 5 分钟）
- [ ] 写操作后调用 `invalidateAuthCache(openid)`

**高风险：staffApi 的 `_testOpenid` 无环境检查**

```bash
# 确认 _testOpenid 的使用方式
grep -n '_testOpenid' */cloudfunctions/*/middleware/auth.js
```

如果 staffApi 的 `_testOpenid` 在生产环境也生效，攻击者可伪造任意 OPENID。

### 2.2 权限检查（管理后台）

**检查项：**

- [ ] 每个 Server Action 首行调用 `requirePermission(session, 'action')`
- [ ] 每个 list/detail action 加 `scopeCondition(session, table.storeId)`
- [ ] mutation 操作记录审计日志 `logOperation()`

```bash
# 找出未调用 requirePermission 的 action
grep -L 'requirePermission' fengyu-admin/src/actions/*.ts
# 找出未调用 scopeCondition 的 list action
grep -L 'scopeCondition' fengyu-admin/src/actions/*.ts
```

### 2.3 云函数权限检查

```bash
# 找出未调用 requireStaffBound/requireManager 的路由 handler
# 对比 index.js 路由表 vs handler 内的权限调用
grep -rn 'exports\.' */cloudfunctions/*/routes/*.js | grep -v 'require'
```

---

## 3 输入校验检查

### 3.1 云函数 payload 校验

**检查项：**

- [ ] 必填字段检查：`if (!param) throw new Error('INVALID_PARAMS:')`
- [ ] 类型检查：数组用 `Array.isArray()`，数字用 `typeof x === 'number'`
- [ ] 长度限制：字符串和数组是否有最大长度检查
- [ ] 枚举值校验：状态/类型值是否与 DB 枚举一致

**常见遗漏：**

```bash
# 找出直接使用 payload 字段但无校验的 handler
grep -rn 'ctx.event.payload' */cloudfunctions/*/routes/*.js | head -30
```

### 3.2 管理后台 Zod 校验

Zod schema 在 Server Action 层自动校验，风险较低。检查：

- [ ] `schemas.ts` 中的正则是否安全（无 ReDoS 风险）
- [ ] `z.coerce` 转换是否可能导致意外类型

---

## 4 敏感数据检查

### 4.1 响应数据脱敏

```bash
# 检查手机号是否在响应中未脱敏
grep -rn 'phone' */cloudfunctions/*/routes/*.js | grep -i 'select'
```

**规则：**
- 客户端返回手机号应脱敏（`138****5678`）
- 员工端根据角色决定是否脱敏
- 身份证号永远不应返回完整值

### 4.2 日志安全

```bash
# 检查日志中是否打印敏感信息
grep -rn 'console.log.*password\|console.log.*phone\|console.log.*openid' */cloudfunctions/
```

### 4.3 Git 仓库安全

```bash
# 检查是否有敏感文件被追踪
git ls-files | grep -i 'env\|secret\|credential\|\.pem\|\.key'
```

---

## 5 报告格式

审查完成后输出：

```markdown
## 安全审查报告 — [审查范围]

### 审查日期：YYYY-MM-DD

### 发现

| 级别 | 类别 | 位置 | 描述 | 建议 |
|------|------|------|------|------|
| HIGH | SQL 注入 | file:line | 描述 | 修复方案 |
| MEDIUM | 输入校验 | file:line | 描述 | 修复方案 |
| LOW | 日志泄露 | file:line | 描述 | 修复方案 |
| INFO | 最佳实践 | — | 描述 | 建议 |

### 统计
- 扫描文件数：N
- HIGH: N / MEDIUM: N / LOW: N / INFO: N

### 已确认安全
- SQL 注入：100% 参数化查询 ✓
- ...
```

---

## 6 已知风险项（项目特有）

| # | 风险 | 级别 | 状态 |
|---|------|------|------|
| 1 | staffApi `_testOpenid` 无环境检查 | HIGH | 待修复 |
| 2 | validate.js 中间件已定义但未被任何路由使用 | MEDIUM | 待评估 |
| 3 | 云函数 payload 无数组长度限制 | MEDIUM | 待评估 |
| 4 | auth 缓存 FIFO 策略（非 LRU） | LOW | 可接受 |
| 5 | 部分端点返回完整手机号 | LOW | 按角色决策 |
