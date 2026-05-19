# 上线前清单（pre-launch checklist）

> 滚动维护：每个开发期临时通道 / 灰度开关 / 后门入口，落地时就追加一条到本文，按 owner 自检。
> 关联记忆：[project_pre_launch_data_wipe](.claude/...) — 上线前会清空 PG 后再上线，历史回填类工单一律 N/A。

---

## ☐ 关闭测试员工切换通道（switchTestUser / _testOpenid）

**Owner**：staff 端
**新增日期**：2026-05-19
**新增背景**：DevTools 里支持 `getApp().switchTestUser('<phone>')` 一行切到任意员工身份，测试不同角色的页面/权限。依赖远端 `ALLOW_TEST_OPENID=true` + 合成 `dev-*` openid 写入 `staff_wechat_users`。生产环境必须关掉。

### 必做步骤

#### 1. 关后端 gate

`fengyu-staff/.env` 删 `ALLOW_TEST_OPENID=true` 后重 deploy：

```bash
cd fengyu-staff && tcb fn code update staffApi
```

效果：middleware + bindPhone + login 的 `_testOpenid` 分支全部失活，前端怎么发都被忽略。

#### 2. 清 DB 残留

```sql
UPDATE staff_wechat_users SET openid = NULL WHERE openid LIKE 'dev-%';
```

**为什么必须**：测试期把 `dev-*` 写进了员工 phone 行的 openid 字段。不清的话，对应员工首次真实微信登录会触发 bindPhone 的"该手机号已被其他账号绑定"守卫。

### 验证

```bash
tcb fn invoke staffApi --params '{"action":"auth.login","payload":{"_testOpenid":"dev-15979157162"}}'
```

预期返回 `isNewUser: true`（说明 `_testOpenid` 被忽略，gate 已死）。

### 可选清理（不影响线上正确性）

| 项 | 改动 | 必要性 |
|----|------|--------|
| 前端 `app.ts` 的 `switchTestUser` 方法 | 删 | 低——backend gate 关后调它会报错，无害 |
| 前端 `utils/cloud.ts` 的 `withAuthContext` 注入 `_testOpenid` | 删 | 低 |
| 前端 `app.ts syncLoginState` 读 `__devTestOpenid` | 删 | 低 |
| `fengyu-staff/scripts/devtools-switch-identity.js` | 删 | 低 |
| 开发者本人 DevTools 的 `__devTestOpenid` localStorage | 清 | 极低 |
| 后端 `routes/auth.js` bindPhone 测试模式换绑放宽 + `phoneNumber` 直传分支 | 删 | 低——已被 gate 守住 |

### 记忆同步

关闭后更新 [`memory/project_allow_test_openid_persistent.md`](.claude/...) 把状态从"长期保留"改为"已关闭（YYYY-MM-DD）"，避免后续 session 误判。

---

## ☐ （示例占位）其他上线前任务

待补充。新增格式：
- 标题以 `## ☐` 起头（完成后改 `## ✅`）
- 必含 Owner / 新增日期 / 新增背景 / 必做步骤 / 验证 / 可选清理 / 记忆同步
