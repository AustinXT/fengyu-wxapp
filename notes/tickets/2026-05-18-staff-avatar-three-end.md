> 生成日期：2026-05-18
> 严重级别：P2（产品体验增强；非紧急合规/数据安全 P0/P1）
> 端：**三端 + db**（fengyu-admin / fengyu-staff / fengyu-client / db schema）
> 影响面：
> - db：`staff_wechat_users` 加 `avatar_url TEXT`（migration 0032）+ `schema/user.ts` 更新
> - staffApi：新增 `staff.uploadAvatar` + `staff.updateAvatar`；`auth.login` / `auth.bindPhone` / `staff.list` / `staff.departments` 等响应增 `avatarUrl`
> - clientApi：`staff.list` / `staff.default` / `staff.detail` 响应增 `avatarUrl`；预约/服务单/订单等含 `employee_id` 的响应按需 JOIN 增 `employee_avatar_url`
> - 管理后台：员工列表头像缩略 + 员工详情/编辑头像上传栏（复用 `image-upload.tsx`）
> - 员工小程序：`pages/profile/profile.wxml` 头像可点击 → 上传/换图（复用 client `auth.uploadAvatar` 同款 base64 代理）
> - 客户小程序：`components/staff-popup` / `pagesShop/staff-detail` / `pagesAppointment/appointment-create` / 订单/预约/服务单详情等所有显示美容师姓名的位置加头像
> 修复成本：M（5–8 天，含三端 UI + DB 迁移 + 测试）
> 前置：无（`client_wechat_users.avatar_url` 已存在 + 全套上传链路已跑通可作蓝本，admin `image-upload.tsx` + `/api/upload` 已就绪）
> 来源：用户请求（2026-05-18 /usage 后口述）

**一句话目标**：员工目前在三端都没有头像（员工小程序"我的"挂死 van-icon manager 图标、客户小程序选美容师时只显示文字 + 通用 user-o 图标），需要在 `staff_wechat_users` 新增 `avatar_url` 字段并打通"admin 上传 / staff 自助上传 / client 三端展示"三条链路，让顾客能看到真人头像选美容师，店长/总部能在 admin 维护员工形象。

---

## 0 一句话背景

`client_wechat_users.avatar_url` 已经存在并跑通了完整链路（云函数 `auth.uploadAvatar` 代理上传 → COS → fileID 写表 → 客户端 `<image src=cloud://...>` 渲染），但 `staff_wechat_users` 缺这个字段。三端涉及员工头像的位置全部退化为占位图标。

> 既有蓝本：`fengyu-client/cloudfunctions/clientApi/routes/auth.js:344-398` (uploadAvatar) + `pagesProfile/profile-edit/profile-edit.ts:29-63` (前端选图/读 base64/调云函数) + `db/schema/user.ts:27` (avatar_url 列声明)。本 ticket 80% 工作是把同款套路在 staff 侧复刻一份，剩下 20% 是 client 展示侧增字段 + admin 上传 UI。

---

## 1 现状盘点

### 1.1 表结构

`db/schema/user.ts`（grep 实证 2026-05-18）：

| 表 | avatar_url 列 |
|---|---|
| `client_wechat_users` (line 27) | ✅ `text('avatar_url')` |
| `staff_wechat_users` (line 97-135) | ❌ **缺** |

10 列定义：employeeId / openid / sessionKey / phone / name / gender / idCard / storeId / orgNodeId / positionName / birthday / skills / isResigned / hiredAt / resignedAt / lastLoginAt。

### 1.2 客户端"美容师 + 文字"的全部位置（grep 实证）

```bash
grep -rln "美容师\|staff" fengyu-client/miniprogram/pages*/ --include="*.wxml" | head
```

| 文件 | 当前展示 | 需改 |
|---|---|---|
| `components/staff-popup/staff-popup.wxml:19,35` | `<van-icon name="user-o\|manager-o">` 占位 | 改 `<image src="{{item.avatarUrl}}">` + fallback 兜底 |
| `pagesShop/staff-detail/staff-detail.wxml:21` | `<view class="staff-avatar">` 空容器 | 填 `<image>` |
| `pagesAppointment/appointment-create/appointment-create.wxml:76` | `defaultStaffName ? '主美容师：' + defaultStaffName` 纯文本 | 文本前置头像 |
| `pagesOrder/checkout/checkout.wxml` + `.ts:229-232` | `staffName + staffWfId` 文字 | 文本前置头像 |
| `pagesOrder/order-detail/order-detail.wxml` | `employee_name` 文字 | 文本前置头像（可选；订单是历史快照） |
| `pages/appointment/appointment.wxml:57` | `<van-cell title="美容师" value="{{item.employee_name || '未指定'}}">` | cell 改图文混排或保持纯文本（待 PM 定） |

### 1.3 员工端"我的"

`fengyu-staff/miniprogram/pages/profile/profile.wxml:4-6`：

```xml
<view class="avatar-wrap">
  <van-icon name="manager" size="80rpx" color="#BBBBBB" />
</view>
```

挂死的灰色 icon，无 `bindtap` 也无 `<image>`。员工无任何途径上传/查看自己头像。

### 1.4 管理后台

`fengyu-admin/src/app/(main)/employees/[id]/_components/employee-detail-page.tsx` — 编辑表单 11 字段（name/gender/phone/idCard/storeId/orgNodeId/positionName/birthday/hiredAt/skills），**无 avatar**。

已就绪的可复用资产：
- `src/components/ui/image-upload.tsx` (353 行) — DnD 单/多图 + `toHttpUrl()` cloud:// → CDN
- `src/app/api/upload/route.ts` — POST 接 file + path/exactKey，调 `uploadFile()` (Node SDK)，5MB 限
- `src/lib/cloudbase.ts:20` — `uploadFile(buffer, cloudPath)` 已就绪
- `CDN_BASE = "https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la"` — admin 上传 → **客户端 env**（关键！见 §2.1）

### 1.5 既有 e2e 蓝本

`fengyu-client/tests/e2e-cloudfn/auth/upload-avatar.spec.mjs` (141 行) — 5 用例覆盖 happy/不支持 ext/缺 base64/空 base64/>2MB，可整体复刻为 `staff/upload-avatar.spec.mjs`。

---

## 2 关键架构决策

### 2.1 双 appid + 双 CloudBase env 的存储位置（**最重要的决策点**）

```
fengyu-client appid wx811eb4ded3dfba3f → envId cloud1-3gpht4b01ff88838
fengyu-staff  appid wxe3f5d9ee6a94d22d → envId cloud1-9g3ydpg512eecc99
fengyu-admin  Node SDK → envId cloud1-3gpht4b01ff88838（client env，与 image-upload.tsx 的 CDN_BASE 一致）
```

`cloud://envId.bucketSuffix/path` 协议头是 **env-scoped**：staff env 上传的 fileID **不能被 client miniprogram 直接 `<image src="cloud://...">` 渲染**（小程序只认本 appid 的 envId）。

**三个候选方案**：

| 方案 | 写入位置 | 读取展示 | 优 | 劣 |
|---|---|---|---|---|
| **A：所有头像都上传到 client env** | admin/staff 上传都写 `cloud1-3gpht4b01ff88838` | client miniprogram `<image src=cloud://...>` 直接渲；staff miniprogram 自渲需走 HTTPS CDN | 客户端最快、无 HTTPS 转换 | staff 云函数要跨 env upload（CloudBase 支持 `cloud.init({env: 'cloud1-3gpht4b01ff88838'})` 切换） |
| **B：存 HTTPS CDN URL（去掉 cloud:// 协议）** | 写入时 = HTTPS CDN URL（统一通过 `toHttpUrl()` 转换后入库） | 三端都用 `<image src=https://...>` | 三端无差别、跨 env 透明 | 需配 `request domainList` 白名单 + 看图也要走外网 |
| **C：两个 env 各自存一份头像** | staff 上传到 staff env / admin 上传到 client env / 同步脚本镜像 | 各 env 各取 | 完全隔离 | 复杂度爆表、双倍存储、同步 lag |

**推荐方案 A**（与 `client_wechat_users.avatar_url` 现有实现一致 — `clientApi.auth.uploadAvatar` 写的就是 client env `cloud://` fileID），具体落地：

1. **admin 上传**：直接复用 `/api/upload`，落 client env（已是默认行为）。`avatar_url` 字段值形如 `cloud://cloud1-3gpht4b01ff88838.xxx/avatars/staff/{employeeId}_{ts}.jpg`
2. **staff miniprogram 上传**：新增 `staff.uploadAvatar` 云函数；初始化 `cloud.init({ env: 'cloud1-3gpht4b01ff88838' })` 走跨 env 上传（写 client env 同一桶）。**验证点**：CloudBase 跨 env upload 需要确认 staff envId 是否有 client env 的写权限——若无，需在 cloudbaserc 显式配 envId
3. **client miniprogram 展示**：`<image src="cloud://...">` 直接渲，无需 toHttpUrl
4. **staff miniprogram 展示自己的头像**：staff env 下渲染 client env 的 `cloud://` URL 不被支持 → 必须先 `cloud://` → HTTPS 转换。在 `utils/cloud.ts` 加 `toHttpUrl(url)`（复制 admin 同名实现）

**回退方案 B**（若 A 第 2 步跨 env upload 不可用）：staff 云函数上传到 staff env，**所有三端**入库前都通过 toHttpUrl 转 HTTPS 串入库 → 库里只存 HTTPS URL，三端展示无差别。代价是图片走外网 + 配 request 白名单。

> **决策门禁**：S1 必须先在本地用 staff env 跑一次 `cloud.init({env:'<client envId>'}).uploadFile(...)`，验证可写；不通过则切方案 B。**整 ticket 在 S0 完成此 spike 之前不开工**。

### 2.2 头像字段长度

参考 `client_wechat_users.avatar_url` 是 `text('avatar_url')`（无长度限），staff 也用 `text`。云函数侧已有 `substring(0, 500)` 兜底（auth.js:327）— staff 实现复刻同样守卫。

### 2.3 头像鉴权与隔私

- staff 本人改自己头像：`staff_wechat_users.openid = ctx.auth.openid` 自匹配，无 scope 顾虑
- admin 改任意员工头像：复用 `'employee:update'` permission（已在 PERMISSION_MATRIX：admin/hr 持有），无新 permission key
- 头像 URL 可视为非敏感（无 PII），下发到客户端无脱敏需求
- 上传图片大小：staff/admin 同步 client 实现的 2MB 上限；admin REST 是 5MB（保持现状即可，admin 仅店长操作 + 自己降采样）

### 2.4 头像兜底 / 缺省 UI

后端返回 `avatarUrl: null` 是合法状态（未上传/未同步）。前端三端约定：

- 客户端 staff-popup / staff-detail：`avatarUrl` null → 渲染 `<van-icon name="manager-o" />`（保持当前占位）
- 员工端 profile：null → `<van-icon name="manager" />` + 点击区显示"点击上传头像"提示
- admin 列表：null → 灰色圆 + 首字（取 name 第一字）

---

## 3 设计目标

### 3.1 数据流（方案 A）

```
[admin]                              [staff miniprogram]
  ↓ /api/upload                        ↓ wx.chooseMedia
  ↓ Node SDK uploadFile()              ↓ getFileSystemManager.readFile → base64
  ↓ env=cloud1-3gpht4b01ff88838        ↓ callStaffApi('staff.uploadAvatar', {base64,ext})
  ↓                                    ↓ staffApi cloud.init({env:'cloud1-3gpht4b01ff88838'})
  ↓ updateEmployee({avatarUrl})        ↓ cloud.uploadFile → fileID (client env)
  ↓ Drizzle UPDATE                     ↓ pg UPDATE staff_wechat_users SET avatar_url
  ↓                                    ↓
  └─────────────  PG staff_wechat_users.avatar_url  ──────────────┘
                          ↓
                          ↓ (读)
       ┌──────────────────┴──────────────────┐
       ↓                                     ↓
  [client miniprogram]               [staff miniprogram 自渲]
  <image src="cloud://..." />        <image src=toHttpUrl(cloud://...) />
  staff.list / staff.detail /        profile.wxml 我的页头像
  staff-popup / 订单 / 预约           （需 url 转换）
```

### 3.2 API 增量清单

#### staffApi 新增

```
staff.uploadAvatar   (本人自助上传，base64 代理同 client uploadAvatar)
staff.updateAvatar   (兼容：传 URL 直接更新；admin 也用同款的话可省略)
```

#### staffApi 修改（响应增字段）

| 接口 | 增字段 |
|---|---|
| `auth.login` | `avatarUrl: user.avatar_url` |
| `auth.bindPhone` 两条返回路径 | `avatarUrl` |
| `staff.list` | 每个 staff item 增 `avatarUrl` |
| `staff.departments` | 美容部成员增 `avatarUrl` |
| `customer.detail` | `boundEmployeeAvatarUrl`（绑定美容师头像） |

#### clientApi 修改（响应增字段）

| 接口 | 增字段 | SQL 改 |
|---|---|---|
| `staff.list` | 列表项增 `avatarUrl` | `SELECT ... , avatar_url FROM staff_wechat_users` |
| `staff.default` | `mainStaffAvatarUrl` | 内层 query 增 `avatar_url` |
| `staff.detail` | `avatarUrl` | 同上 |
| `appointment.list` / `appointment.create`（返）| `employee_avatar_url` | LEFT JOIN staff_wechat_users 增 `sw.avatar_url AS employee_avatar_url` |
| `service.detail` / `service.list` | `assigned_employee_avatar_url` | 同上 |
| `order.detail` | `preferred_employee_avatar_url`（如果详情含该字段） | 视产品决定 |
| `auth.login` | （顾客自己头像已有）— 不变 | — |

> **范围克制**：订单/预约/服务单详情等"历史已发生事项"是否要显示美容师头像，**默认本期只在"展示美容师列表/详情/选美容师弹层"加**，订单详情仍保持文字（员工换头像后老订单不回改逻辑会更简单；要不要回写历史快照另开 ticket）。

#### admin Server Actions

```ts
// fengyu-admin/src/actions/employees.ts
// updateEmployee 的 data 入参加 avatarUrl?: string | null
// rowToEmployee 增 avatarUrl
```

```ts
// fengyu-admin/src/lib/types.ts:39 Employee 接口
+ avatarUrl: string | null
```

---

## 4 详细变更清单（按层）

### 4.1 L0 — DB schema

**File**：`db/schema/user.ts:97-135`

```ts
export const staffWechatUsers = pgTable('staff_wechat_users', {
  // ... 现有字段 ...
  positionName: varchar('position_name', { length: 50 }),
+ /** 头像 URL（admin 后台上传 / 员工小程序"我的"自助上传；存 cloud:// 协议） */
+ avatarUrl: text('avatar_url'),
  // Layer 4 — 个人档案
  birthday: date('birthday'),
  ...
})
```

**Migration**：`bun run db:generate` → 产出 `db/migrations/0032_<slug>.sql`（drizzle-kit 自动）。SQL 应是：

```sql
ALTER TABLE "staff_wechat_users" ADD COLUMN "avatar_url" text;
```

零默认值、零约束、可空。不破坏现有 INSERT/UPDATE。

**Sync 兼容**：`db/scripts/sync-workfine.js:351-376` 的 UPSERT 不涉及 avatar_url（已 grep 实证），不会被 sync 覆盖为 null。**且** WorkFine 同步自 2026-04-16 已停（memory `workfine_sync_stopped`），即使 ON CONFLICT 列表里漏写 avatar_url 也不会丢数据。

### 4.2 L1 — staffApi 云函数

#### 4.2.1 新增 `routes/staff.js` / `uploadAvatar` 函数（建议放 staff.js，与 admin/staff 复用同一权限链）

```js
// fengyu-staff/cloudfunctions/staffApi/routes/staff.js

const cloud = require('wx-server-sdk')
// 关键：跨 env upload — 显式初始化 client env
// 若使用方案 B（同 env upload + HTTPS CDN URL），删除此行，cloud.init() 默认 staff env
const CLIENT_ENV_ID = 'cloud1-3gpht4b01ff88838'

async function uploadAvatar(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const { base64, ext } = ctx.event.payload || {}
  const { OPENID } = cloud.getWXContext()

  if (!base64 || typeof base64 !== 'string') {
    throw new Error('INVALID_PARAMS: 缺少 base64 参数')
  }
  const normalizedExt = String(ext || 'jpg').toLowerCase()
  const allowedExts = ['jpg', 'jpeg', 'png', 'webp']
  if (!allowedExts.includes(normalizedExt)) {
    throw new Error('INVALID_PARAMS: 不支持的图片格式')
  }
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) throw new Error('INVALID_PARAMS: 头像数据解析失败')
  if (buffer.length > 2 * 1024 * 1024) throw new Error('INVALID_PARAMS: 图片大小超过 2MB')

  const employeeId = ctx.auth.staffWfId
  if (!employeeId) throw new Error('UNAUTHORIZED: 员工档案未关联')

  const rand = Math.random().toString(36).slice(2, 8)
  const cloudPath = `avatars/staff/${employeeId}_${Date.now()}_${rand}.${normalizedExt}`

  // 方案 A：跨 env upload
  const crossEnvCloud = cloud  // 注：若 wx-server-sdk 不支持运行时切 env，需用 cloud.Cloud 实例
  const uploadRes = await crossEnvCloud.uploadFile({
    cloudPath,
    fileContent: buffer,
    config: { env: CLIENT_ENV_ID },  // ← 关键，需确认 wx-server-sdk 支持
  })
  const fileID = uploadRes.fileID
  if (!fileID) throw new Error('INVALID_PARAMS: 上传失败')

  await pg.query(
    'UPDATE staff_wechat_users SET avatar_url = $1, updated_at = now() WHERE employee_id = $2',
    [fileID, employeeId]
  )

  const { invalidateAuthCache } = require('../middleware/auth')
  invalidateAuthCache(OPENID)

  ctx.result = { fileID, avatarUrl: fileID }
}
```

**关键风险**：`wx-server-sdk` 跨 env upload 的 API（`config.env`）必须 spike 验证。若不支持，备选：
- 用 `tcb-admin-node` SDK（独立 Node SDK，envId 显式声明）
- 或退方案 B（同 env upload + HTTPS URL）

#### 4.2.2 修改 `routes/auth.js` 响应

`auth.js:107-119` 的 login query 加 `u.avatar_url`，第 151-165 ctx.result 加 `avatarUrl: user.avatar_url`。bindPhone 两条 return 同样追加（line 217-231 query + line 250-264, 283-297 result）。

#### 4.2.3 修改 `routes/staff.js` 现有响应

`staff.list` (line 24-53)：SELECT 加 `u.avatar_url`，map 输出加 `avatarUrl: r.avatar_url ?? null`。
`staff.departments`：同上。

#### 4.2.4 `index.js` 路由表

```js
'staff.uploadAvatar':   () => require('./routes/staff').uploadAvatar,
```

### 4.3 L1 — clientApi 云函数

#### 4.3.1 `routes/staff.js`

- `list` (line 12-33): SELECT 加 `avatar_url`，结果项加 `avatarUrl`
- `defaultStaff` (line 40-92): 内层 staffList query 加 `avatar_url`；ctx.result 加 `mainStaffAvatarUrl`
- `detail` (line 98-139): SELECT 加 `s.avatar_url`；ctx.result 加 `avatarUrl`

#### 4.3.2 `routes/appointment.js` / `service.js` / `order.js`

凡是 `LEFT JOIN staff_wechat_users sw ON ...` 的 query，在 SELECT 增 `sw.avatar_url AS employee_avatar_url`（或对应别名）。客户端按需展示。

> **范围克制再次确认**：本 ticket 默认**仅改 staff.* 三个接口 + appointment.list（顾客预约自家美容师高频）**，订单详情/服务详情若产品要等下一迭代，删掉对应改动即可。

### 4.4 L2 — 员工端小程序

#### 4.4.1 `pages/profile/profile.wxml` 头像位置

```xml
<view class="avatar-wrap" bindtap="onChooseAvatar">
  <image wx:if="{{avatarUrl}}" src="{{avatarUrlHttp}}" class="avatar-image" mode="aspectFill" />
  <van-icon wx:else name="manager" size="80rpx" color="#BBBBBB" />
</view>
<text class="avatar-hint" wx:if="{{!avatarUrl}}">点击上传头像</text>
```

`profile.ts`：
- onLoad 从 globalData 读 `avatarUrl`（login/bindPhone 已下发），通过 `toHttpUrl()` 转 HTTPS 存 `avatarUrlHttp`（方案 A：跨 env 渲染必须走 HTTPS）
- `onChooseAvatar`：完全复刻 client 的 `pagesProfile/profile-edit/profile-edit.ts:29-63`（wx.chooseMedia + getFileSystemManager.readFile + callStaffApi('staff.uploadAvatar')）

#### 4.4.2 `app.ts` / `app.globalData`

`StaffGlobalData` interface 加 `avatarUrl: string | null`。`syncLoginState` 后写入。

#### 4.4.3 `utils/cloud.ts` 加 `toHttpUrl`

复制 admin 同款实现（image-upload.tsx:32-44），CDN_BASE 同 admin。

### 4.5 L2 — 顾客端小程序

#### 4.5.1 `components/staff-popup/staff-popup.wxml`

```xml
<view class="staff-avatar">
  <image wx:if="{{item.avatarUrl}}" src="{{item.avatarUrl}}" class="staff-avatar-img" mode="aspectFill" />
  <van-icon wx:else name="manager-o" size="48rpx" color="#C0322A" />
</view>
```

注：client env 下渲染 client env `cloud://` 协议直接合法，无需 toHttpUrl。

`staff-popup.wxss` 加 `.staff-avatar-img { width: 80rpx; height: 80rpx; border-radius: 50%; }`。

#### 4.5.2 `pagesShop/staff-detail/staff-detail.wxml:21`

填头像 `<image>`，同上 fallback。

#### 4.5.3 `pagesAppointment/appointment-create/appointment-create.wxml:73-79`

```xml
<van-cell-group title="指定美容师（可选）" inset>
  <view class="default-staff-line" wx:if="{{defaultStaffName}}">
    <image wx:if="{{defaultStaffAvatarUrl}}" src="{{defaultStaffAvatarUrl}}" class="default-staff-avatar" mode="aspectFill" />
    <text>主美容师：{{defaultStaffName}}</text>
  </view>
  ...
</van-cell-group>
```

`appointment-create.ts:131-134` 加 `defaultStaffAvatarUrl: data.mainStaffAvatarUrl || ''`。

同款改动到 `pagesOrder/checkout/checkout.ts:229-232` + 对应 wxml。

#### 4.5.4 `pages/appointment/appointment.wxml:57`

```xml
<view class="cell-with-avatar">
  <image wx:if="{{item.employee_avatar_url}}" src="{{item.employee_avatar_url}}" class="appt-mini-avatar" mode="aspectFill" />
  <van-cell title="美容师" value="{{item.employee_name || '未指定'}}" icon="contact" />
</view>
```

（或保持纯文本，等产品确认）

### 4.6 L3 — 管理后台

#### 4.6.1 `src/lib/types.ts` Employee 增字段

```ts
export interface Employee {
  ...
  positionName: string | null
+ avatarUrl: string | null
  birthday: string | null
  ...
}
```

#### 4.6.2 `src/actions/employees.ts`

- `rowToEmployee` 增 `avatarUrl: e.avatarUrl`
- `updateEmployee` 的 data 入参 `Partial<{...}>` 增 `avatarUrl: string | null`
- 无新 action（admin 上传走通用 `/api/upload` 拿 URL → 调 updateEmployee 即可）

#### 4.6.3 `src/app/(main)/employees/[id]/_components/employee-detail-page.tsx`

在 `<Card>` 顶部加头像编辑区，复用 `<ImageUpload mode="single" path="avatars/staff" value={form.avatarUrl} onChange={...} />`（具体 props 看 image-upload.tsx 暴露的接口，下面假设是单图模式）：

```tsx
<div className="flex items-center gap-4 mb-4">
  <ImageUpload
    mode="single"
    path="avatars/staff"
    value={form.avatarUrl}
    onChange={(url) => setForm({ ...form, avatarUrl: url })}
    disabled={!isEditing}
  />
  <div>{employee.name}</div>
</div>
```

提交时 `updateEmployee(employeeId, { ...form }, expectedUpdatedAt)` — 已支持新字段。

#### 4.6.4 `src/app/(main)/employees/_components/employees-page.tsx`

列表表格首列加缩略图 32px 圆形（null 渲染灰圆 + 首字 fallback）。

#### 4.6.5 `src/app/(main)/employees/create/_components/employee-create-page.tsx`

创建表单也加同款 ImageUpload。`createEmployee` 入参对应加 `avatarUrl?: string | null`，service 层 INSERT 时一并写入。

---

## 5 迁移策略（按 Stage）

| Stage | 内容 | 工期 |
|---|---|---|
| **S0（spike 门禁）** | wx-server-sdk 跨 env upload 验证：本地起 staff envId 的 cloud function，`cloud.uploadFile({config:{env:'<client envId>'}})` 上传一张图，确认 fileID 真落在 client env 桶里。**不通过 → 切方案 B（HTTPS URL 存库 + 同 env upload）**，§4.2 / §4.4 调整 | 0.5 天 |
| **S1（L0 + L1 db / staffApi）** | migration 0032 + schema 改 + staffApi 新增 uploadAvatar + 各 query 加 avatar_url 列 + 单元测试 + L2 e2e（复制 client upload-avatar.spec.mjs 改名） | 1.5 天 |
| **S2（L1 clientApi）** | clientApi staff.* 三接口加 avatarUrl + appointment.list（如有）+ L2 e2e | 0.5 天 |
| **S3（L2 admin）** | Employee 类型 + updateEmployee 入参 + employee-detail-page / employee-create-page ImageUpload + employees-page 列表缩略 + Vitest 单测 | 1.5 天 |
| **S4（L2 client miniprogram）** | staff-popup / staff-detail / appointment-create / checkout 头像渲染 + wxss + L3 e2e（j10 staff 详情、j5 appointment 等 journey 补 visual 检查） | 1 天 |
| **S5（L2 staff miniprogram）** | profile.wxml 头像可点 + onChooseAvatar + utils/cloud.ts 加 toHttpUrl + globalData.avatarUrl 联通 + L3 e2e | 1 天 |
| **S6（跨端联调 + 文档）** | 三端真机/IDE 联调（admin 上传 → staff 看到自己 → client 看到 staff）+ 更新 `.42cog/dev/*.sys.spec.md` + memory 更新 | 0.5 天 |

**总工期：5–6.5 天**（按 spike 顺利方案 A 估算；切方案 B + S1/S5 简化 + S4 加 toHttpUrl → 同等量级）。

S0 spike 必须先做。S1 ~ S6 内 S1/S2 串行（共享 DB schema），S3/S4/S5 可并行（不同子项目）。

---

## 6 验证 Checklist

### 6.1 DB / 后端

- [ ] `cd db && bun run db:generate` 产出 `0032_*.sql`，diff 仅含 `ALTER TABLE staff_wechat_users ADD COLUMN avatar_url text`
- [ ] 临时 docker PG 空库 `npx drizzle-kit migrate` 全量 apply 通过
- [ ] 对 5434 生产业务库跑 `npm run db:migrate`；冷备 5433 可选双跑
- [ ] `bun fengyu-staff/cloudfunctions/staffApi/__tests__/...` 单测全绿
- [ ] `bun fengyu-staff/tests/e2e-cloudfn/staff/upload-avatar.spec.mjs` 5 用例全绿（happy/不支持 ext/缺 base64/空 base64/>2MB）
- [ ] `bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter staff` 全套不回归
- [ ] `bun fengyu-client/tests/e2e-cloudfn/run-all.mjs --filter staff` 全套不回归（含 staff.list 含 avatarUrl 字段断言）

### 6.2 admin

- [ ] `cd fengyu-admin && npx tsc --noEmit` 0 类型错误
- [ ] `bun run test` Vitest 全绿（含 employees.test.ts avatarUrl 入参覆盖）
- [ ] `bun run build` Next.js 15 构建通过
- [ ] 手工：登录 admin → 员工详情 → 编辑 → 上传头像 → 保存 → 列表显示缩略
- [ ] 同步：上传后 `SELECT avatar_url FROM staff_wechat_users WHERE employee_id = '<id>'` 拿到 `cloud://cloud1-3gpht4b01ff88838...`

### 6.3 staff miniprogram

- [ ] 微信开发者工具 fengyu-staff/miniprogram/ 打开，登录 → 我的 → 点头像 → 选图 → 上传 → 渲染（HTTPS URL）
- [ ] L3 j-profile.spec.mjs（新增）覆盖上传 → globalData 更新 → 页面 setData 渲染
- [ ] **跨端验证**：staff 上传后立即在 client 端"美容师列表"看到新头像

### 6.4 client miniprogram

- [ ] L3 staff-popup / staff-detail / appointment-create 现有 journey 不回归
- [ ] `<image src="cloud://...">` 直接渲染成功（不必 HTTPS 转换；同 env 内合法）
- [ ] 新增 j-staff-avatar.spec.mjs 覆盖"列表头像渲染 / null fallback / 选完头像传到下一页"

### 6.5 跨端一致性

- [ ] cleanup：测试创建的临时头像 fileID 由 `fengyu-staff/tests/e2e-cloudfn/cleanup.mjs` 含 staff_wechat_users.avatar_url 清空逻辑（避免 COS 残留垃圾图）
- [ ] error-codes 跨端 snapshot 测试不漂移（新增的 INVALID_PARAMS 子标签无新规）

---

## 7 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| **wx-server-sdk 不支持运行时 `config.env` 跨 env upload** | 方案 A 不可行 | S0 spike 验证；不通过切方案 B（同 env upload + 全用 HTTPS URL） |
| **staff env 上传到 client env 触发权限拒绝**（envId 列表配置） | 跨 env 写失败 | 在 fengyu-staff/cloudfunctions/staffApi 的 cloudbaserc 显式加 client envId 到 allowed list；或申请 client env 配置允许 staff envId 写入；或退方案 B |
| **历史已绑定客户看到旧员工无头像** | UI 退化为 fallback icon | 设计上接受；不回写 |
| client miniprogram 渲染 staff env `cloud://` 失败（万一方案 A 走偏）| 头像空白 | 入库前由云函数统一调 `toHttpUrl()` 转 HTTPS 入库，三端无差别 |
| **headers 转 base64 解码膨胀**（2MB 限对应原图约 1.5MB）| 高分辨率自拍传不上 | wx.chooseMedia 已配 `sizeType: ['compressed']`；如仍超界，前端先做 canvas 压缩 |
| admin 列表批量加载头像导致首屏慢 | 列表渲染 lag | 列表项只渲染 32×32 缩略 + lazy-load；URL 经 CDN 自带 webp 转换 |
| `cloudbaserc.json` 不入 git（memory `cloudbaserc_not_in_git`）的 envId 配置漂移 | 部署后 envId 错 | 通过 `.env.example` 暴露需要的 envId 占位；§6 验证手工写好部署 checklist |
| **生产已有头像的员工被 admin 改名/同步覆盖丢失**（同步脚本误覆盖 avatar_url） | 头像清空 | sync UPSERT ON CONFLICT 列表不含 avatar_url（§4.1 已实证）；WorkFine sync 已停（memory `workfine_sync_stopped`）双重保险 |

**回滚策略**：

- 任意 stage PR 独立 revert
- DB migration 已 apply 后不回滚（avatar_url 列为可空，留空即可）
- 头像 URL 入库后无外键、无业务依赖，运行时切回 fallback icon 完全无感

---

## 8 关联

- **来源**：用户口述（2026-05-18 /usage 后追加需求）
- **既有蓝本**：
  - `fengyu-client/cloudfunctions/clientApi/routes/auth.js:344-398` (`uploadAvatar`) ← staff 侧 §4.2.1 直接复刻
  - `fengyu-client/miniprogram/pagesProfile/profile-edit/profile-edit.ts:29-63` (`onChooseAvatar`) ← staff 侧 §4.4.1 直接复刻
  - `fengyu-client/tests/e2e-cloudfn/auth/upload-avatar.spec.mjs` ← staff 侧 §S1 e2e 直接复刻
  - `fengyu-admin/src/components/ui/image-upload.tsx` + `src/app/api/upload/route.ts` ← admin 侧 §4.6.3 直接复用
  - `db/schema/user.ts:27` (`client_wechat_users.avatarUrl`) ← schema 形态对齐
- **不在本 ticket 范围**：
  - 订单/服务单**历史快照**回填 employee_avatar_url（数据治理另议；快照本应不可变）
  - admin 给员工**裁剪/旋转/滤镜**等图像编辑（本期只上传）
  - 头像**审核流程**（人审/AI 审）— 现 client 端也无审核，先对齐
  - 美容师**对外营销资料卡**（多图相册/视频）— 远期产品需求
- **相关 memory / 文档**：
  - `project_workfine_sync_stopped.md` — sync 已停，avatar_url 不会被覆盖
  - `project_cloudbase_envvar_risk.md` — 部署后须验 staff env 是否能跨写 client env
  - `feedback_no_legacy_compat.md` — 不为"已有员工无头像"做兼容兜底逻辑，UI fallback 即可
  - `feedback_cloudbaserc_not_in_git.md` — envId 配置走 .env 不入 git
  - `feedback_vant_weapp_priority.md` — 三端 UI 用 Vant 组件 + `<image>` 原生，不引第三方头像组件
- **后续可能 ticket**：
  - 历史订单/预约头像回填（snapshot 一致性）
  - 客户端"主美容师"卡片改造（更突出头像）
  - 员工头像审核工作流

---

## 9 复核反馈区（R1 待填）

> 实施前/中由 code reviewer 在此追加反馈块（参考 2026-05-17 各 ticket 的 R2 块格式）。重点复核：
>
> 1. S0 spike 结果（决定方案 A/B）
> 2. clientApi/staffApi 增 avatarUrl 后 L2 测试断言面是否完备
> 3. 三端展示位是否漏（特别是 service-detail、order-detail、客户分配页等隐藏路径）
> 4. ImageUpload 组件在 employee-create/edit 的乐观锁交互（图传成功但表单未保存时垃圾文件留存？）
> 5. 跨 env upload 的部署期 envId 配置如何写文档防误（避免 P0 上线即坏）
