#!/bin/bash
# 查询 fengyu-analyst 使用记录
# Usage: scripts/query-analyst-logs.sh [days] [env]

set -euo pipefail

DAYS="${1:-7}"
ENV="${2:-dev}"

if [[ "$ENV" == "prod" ]]; then
  PG_CONNECTION_STRING="postgresql://fengyu:fengyu123@118.178.196.26:5433/fengyu_wxapp"
elif [[ "$ENV" == "dev" ]]; then
  PG_CONNECTION_STRING="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp"
else
  echo "错误：ENV 必须是 dev 或 prod" >&2
  exit 1
fi

echo "==> 查询最近 $DAYS 天的 fengyu-analyst 使用情况 ($ENV 环境)"
echo ""

echo "--- 使用统计 ---"
psql "$PG_CONNECTION_STRING" <<SQL
SELECT
  COUNT(*) as 总提问次数,
  COUNT(DISTINCT operator_employee_id) as 使用人数,
  COUNT(*) FILTER (WHERE detail->>'hasAiAnswer' = 'true') as AI回答次数,
  COUNT(*) FILTER (WHERE detail->>'hasAiAnswer' = 'false') as 本地回答次数,
  MIN(created_at) as 最早提问时间,
  MAX(created_at) as 最近提问时间
FROM operation_logs
WHERE action = 'analyst.chat'
  AND created_at >= NOW() - INTERVAL '$DAYS days';
SQL

echo ""
echo "--- 活跃用户 TOP 10 ---"
psql "$PG_CONNECTION_STRING" <<SQL
SELECT
  operator_name as 姓名,
  operator_employee_id as 工号,
  operator_role as 角色,
  org_node_name as 组织,
  COUNT(*) as 提问次数,
  MAX(created_at) as 最后提问时间
FROM operation_logs
WHERE action = 'analyst.chat'
  AND created_at >= NOW() - INTERVAL '$DAYS days'
GROUP BY operator_employee_id, operator_name, operator_role, org_node_name
ORDER BY COUNT(*) DESC
LIMIT 10;
SQL

echo ""
echo "--- 最近 20 条提问记录 ---"
psql "$PG_CONNECTION_STRING" <<SQL
SELECT
  operator_name as 姓名,
  detail->>'question' as 问题,
  detail->>'hasAiAnswer' as AI回答,
  detail->>'visualizationCount' as 图表数,
  detail->>'errorType' as 错误类型,
  TO_CHAR(created_at, 'MM-DD HH24:MI') as 时间
FROM operation_logs
WHERE action = 'analyst.chat'
  AND created_at >= NOW() - INTERVAL '$DAYS days'
ORDER BY created_at DESC
LIMIT 20;
SQL

echo ""
echo "--- 高频问题 TOP 10 ---"
psql "$PG_CONNECTION_STRING" <<SQL
SELECT
  detail->>'question' as 问题,
  COUNT(*) as 提问次数,
  COUNT(DISTINCT operator_employee_id) as 提问人数
FROM operation_logs
WHERE action = 'analyst.chat'
  AND created_at >= NOW() - INTERVAL '$DAYS days'
GROUP BY detail->>'question'
ORDER BY COUNT(*) DESC
LIMIT 10;
SQL
