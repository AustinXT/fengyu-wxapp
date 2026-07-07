#!/bin/bash



echo "========================================"
echo "Fengyu PostgreSQL 数据库验证"
echo "========================================"
echo ""


echo "1️⃣  测试数据库连接..."
if docker exec fengyu-postgres pg_isready -U fengyu -d fengyu > /dev/null 2>&1; then
    echo "✅ 数据库连接正常"
else
    echo "❌ 数据库连接失败"
    exit 1
fi

echo ""
echo "2️⃣  查看数据表..."
docker exec fengyu-postgres psql -U fengyu -d fengyu -c "\dt" 2>/dev/null

echo ""
echo "3️⃣  查看枚举类型..."
docker exec fengyu-postgres psql -U fengyu -d fengyu -c "\dT+ public.*" 2>/dev/null | grep -E "appointment_status|order_status|product_type|service_order_status|payment_method|order_source|order_type|big_category|workfine_source"

echo ""
echo "4️⃣  查看索引..."
docker exec fengyu-postgres psql -U fengyu -d fengyu -c "\di" 2>/dev/null

echo ""
echo "5️⃣  查看数据库统计..."
docker exec fengyu-postgres psql -U fengyu -d fengyu -c "
SELECT
    schemaname,
    COUNT(*) as table_count
FROM pg_tables
WHERE schemaname = 'public'
GROUP BY schemaname;
" 2>/dev/null

echo ""
echo "========================================"
echo "✅ 验证完成"
echo "========================================"
