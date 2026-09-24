# Fengyu Analyst 操作日志

## 功能说明

从 2026-08-03 开始，fengyu-analyst 的智能助手对话会自动记录到 `operation_logs` 表中，用于：

- 📊 追踪使用情况和活跃用户
- 🔍 了解用户常见问题
- 📈 分析功能使用趋势
- 🐛 问题排查和错误追踪

## 日志结构

每条对话记录包含：

| 字段 | 说明 |
|------|------|
| `operator_employee_id` | 提问人工号 |
| `operator_name` | 提问人姓名 |
| `operator_role` | 提问人角色 |
| `org_node_id` / `org_node_name` | 所属组织节点 |
| `action` | `analyst.chat`（固定值） |
| `target_type` | `analyst_chat`（固定值） |
| `target_id` | 唯一对话 ID（格式：`chat-{timestamp}-{random}`） |
| `source` | `analystApi`（固定值） |
| `created_at` | 提问时间 |

### detail 字段结构

```json
{
  "_v": 1,
  "_t": "chat",
  "question": "用户提问内容（最多500字符）",
  "hasAiAnswer": true,  // 是否使用 AI 回答
  "visualizationCount": 2,  // 返回的图表数量
  "errorType": "ai_provider_failed"  // 错误类型（可选）
}
```

**注意**：敏感信息（手机号、身份证、openid 等）会自动脱敏后入库。

## 查询使用记录

### 快速查询脚本

```bash
# 查询最近 7 天（默认）
./scripts/query-analyst-logs.sh

# 查询最近 30 天
./scripts/query-analyst-logs.sh 30

# 查询 prod 环境最近 7 天
./scripts/query-analyst-logs.sh 7 prod
```

查询结果包括：
1. 使用统计（总提问次数、使用人数、AI/本地回答比例）
2. 活跃用户 TOP 10
3. 最近 20 条提问记录
4. 高频问题 TOP 10

### 手动 SQL 查询

连接数据库：

```bash
# dev 环境（lx-test）
psql "postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp"

# prod 环境（lx-prod）
psql "postgresql://fengyu:fengyu123@118.178.196.26:5433/fengyu_wxapp"
```

⚠ 旧的 `47.113.202.7` 已于 2026-09-01 全面弃用（见 issue #151）。它**仍可连通**但数据停在
2026-08-24，连上不报错、只是安静地给旧数据——照抄旧地址会拿着陈旧数据下结论。

查询示例：

```sql
-- 查看某个用户的提问历史
SELECT
  detail->>'question' as question,
  detail->>'hasAiAnswer' as has_ai_answer,
  created_at
FROM operation_logs
WHERE action = 'analyst.chat'
  AND operator_employee_id = 'FY-260604001'
ORDER BY created_at DESC
LIMIT 20;

-- 查看错误分布
SELECT
  detail->>'errorType' as error_type,
  COUNT(*) as count
FROM operation_logs
WHERE action = 'analyst.chat'
  AND detail->>'errorType' IS NOT NULL
GROUP BY detail->>'errorType'
ORDER BY count DESC;

-- 查看每日使用趋势
SELECT
  DATE(created_at) as date,
  COUNT(*) as total_questions,
  COUNT(DISTINCT operator_employee_id) as unique_users
FROM operation_logs
WHERE action = 'analyst.chat'
  AND created_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

## 实现细节

### 新增文件

1. **`fengyu-analyst/src/lib/pii.ts`**
   - PII 脱敏工具函数
   - 与 fengyu-admin 保持字面一致

2. **`fengyu-analyst/src/lib/operation-log.ts`**
   - 操作日志记录函数
   - `logOperation()` - 通用日志记录
   - `logAnalystChat()` - 专门记录对话

3. **`fengyu-analyst/src/lib/__tests__/operation-log.test.ts`**
   - PII 脱敏测试用例

4. **`scripts/query-analyst-logs.sh`**
   - 便捷查询脚本

### 修改文件

- **`fengyu-analyst/src/app/api/analyst/chat/route.ts`**
  - 在三个关键位置插入日志记录：
    1. 无 AI 配置时（使用本地回答）
    2. AI 回答成功
    3. AI 失败回退到本地回答

## 数据隐私

- 所有敏感字段（phone、idCard、openid 等）会在入库前自动脱敏
- 脱敏规则与 fengyu-admin 保持一致
- 用户提问内容限制在 500 字符以内

## 测试

```bash
# 运行 PII 脱敏测试
npm test -- src/lib/__tests__/operation-log.test.ts

# TypeScript 类型检查
cd fengyu-analyst && npx tsc --noEmit
```

## 后续优化建议

1. **可视化面板**：在 fengyu-admin 中创建 analyst 使用情况看板
2. **问题分类**：基于高频问题优化预设 prompt 和数据查询
3. **性能监控**：记录查询耗时，识别慢查询
4. **用户反馈**：添加"有用/无用"反馈按钮，记录到日志
