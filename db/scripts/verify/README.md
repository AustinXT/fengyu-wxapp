# 真实 PG 语义验证（手动跑，不在 CI 基线里）

这些脚本起一个**临时 docker PG**，用守护测试同款正则从源码里提取**真实 SQL** 执行正负例。
它们补的是单测覆盖不到的那一层：仓里的 SQL 断言全是文本级 mock，**SQL 本身能不能跑、
语义对不对，只有真连库才知道**。

不接任何业务库，不进 `vitest` / `db:test` 基线（依赖 docker，CI 里没有）。

## customer-type-sql.mjs — 顾客分类跃迁（#187）

```bash
# 1. 起临时库
docker run --rm -d -p 55487:5432 \
  -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=fy187 \
  --name pg-187-verify postgres:16
sleep 6

# 2. 建最小 schema + 灌正负例，再 apply migration 0043 的 helper
docker cp db/scripts/verify/customer-type-fixtures.sql pg-187-verify:/tmp/s.sql
docker exec pg-187-verify psql -U postgres -d fy187 -v ON_ERROR_STOP=1 -q -f /tmp/s.sql
docker exec pg-187-verify psql -U postgres -d fy187 -v ON_ERROR_STOP=1 -q \
  -c "$(sed 's/--> statement-breakpoint//' db/migrations/0043_try_cast_helpers.sql)"

# 3. 跑（从 staffApi 源码提取 CTE/CASE/两段归因，替换参数后执行）
node db/scripts/verify/customer-type-sql.mjs

# 4. 清理
docker stop pg-187-verify
```

脚本**自己核对期望值**：每行打 `✓`/`✗`，任一不符即以退出码 1 结束（可直接串进别的检查）。
失败时会保留生成的 SQL 目录路径，可贴进 psql 复现；全通过时自动清理。

```
=== 三档判定 ===
✓ U_mix         期望 小美客 / 实际 小美客  — 混合订单 体验500+非体验1600=2100…
…
=== 归因 UPDATE ===
✓ became_member_at           期望 2026-01-11 / 实际 2026-01-11
✓ is_membership_upgrade 打标单  期望 O_pure / 实际 O_pure

✅ 全部通过（15 组判定 + 2 项归因）
```

自检过它确实会失败：去掉源码里的 `LEAST(..., si.sale_amount)` 封顶后跑，
输出 `✗ U_overrefund 期望 小美客 / 实际 会员客` 并 `❌ 1 项不符`。

### 覆盖的 15 组（每组都对应一个曾经真实存在或被评审指出的缺陷）

| 用例 | 场景 | 期望 |
|---|---|---|
| `U_mix` | 体验卡 500 + 普通商品 1600 = 2100（阈值 1980） | 小美客（**本 issue 的核心口径**，旧口径判会员客） |
| `U_pure` | 纯非体验 2000 | 会员客 |
| `U_trial` | 只买体验卡 680 | 体验客 |
| `U_small` | 非体验 500 | 小美客 |
| `U_refund` | 付清 2000 后退 1500 | 会员客（退款不扣减，毛实收仍 2000） |
| `U_partial` | 部分支付已收 2500 未结清 | 流量客（不参与判定） |
| `U_none` | 无订单 | 流量客 |
| `U_zero` | 已结清但 received=0 | 流量客（相对旧口径是行为变化） |
| `U_legacy` | WorkFine 历史单只有订单头、无 sale_items 行 | 会员客（回退订单级 received；INNER JOIN 会让它消失 → 回归） |
| `U_overrefund` | 退款 note 记 9999 > 行毛额 500 | 小美客（`LEAST` 封顶；不封顶会误升会员客） |
| `U_badjson` | note = `{手工备注不是合法JSON}` | 会员客且**不抛 22P02** |
| `U_truncjson` | note = `{"items":`（截断） | 会员客且不抛错（`LIKE '{"%'` 守门挡不住，靠 `try_jsonb`） |
| `U_badnum` | `refundAmount: "abc"` | 会员客且不抛错（靠 `try_numeric`） |
| `U_xorder` | A 单的退款 note 错写 B 单的 item id | 小美客（复合键 JOIN；单键会把 B 推到满额 → 误升） |
| `U_exitonly` | 整单只含「退出」方向明细 | 流量客（`COUNT(购买行)=0` 会误走回退分支、绕过封顶） |

另外 fixtures 里还埋了三类不该被计入的脏流水：非 JSON 备注、`items` 非数组、`status='已作废'` 的退款。

### 维护提示

- 脚本用的正则**与守护测试 `recalc-customer-type-sql.test.js` 同款**。改了 SQL 结构（比如
  `GROUP BY` 尾部）两边都要同步，否则这里会报「提取失败」。
- fixtures 是**最小 schema**，只建判定用得到的列。跃迁 SQL 引用新列时要在这里补。
