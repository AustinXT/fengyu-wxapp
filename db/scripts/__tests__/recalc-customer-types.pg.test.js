'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Client } = require('pg')
const { recalcCustomerTypesInTransaction } = require('../recalc-all-customer-types')
const url = process.env.CUSTOMER_TYPE_PG_TEST_URL

// 仅一次性私有容器；绝不触及业务库/共享测试库。
test('历史分类：真实SQL、离线只升不降与历史保留、幂等、补等级/时间且不设置权益标记', { skip: !url }, async () => {
  const parsed = new URL(url)
  assert.ok(['localhost', '127.0.0.1'].includes(parsed.hostname))
  assert.equal(parsed.port, '54416')
  assert.equal(parsed.pathname, '/postgres')
  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    await db.query('BEGIN')
    await db.query(`
      CREATE TYPE customer_type AS ENUM ('流量客','体验客','小美客','会员客');
      CREATE TYPE member_level AS ENUM ('初钻','星钻','粉钻','金钻','黑钻');
      CREATE FUNCTION public.try_jsonb(text) RETURNS jsonb LANGUAGE plpgsql AS $$
        BEGIN RETURN $1::jsonb; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $$;
      CREATE FUNCTION public.try_numeric(text) RETURNS numeric LANGUAGE plpgsql AS $$
        BEGIN RETURN $1::numeric; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $$;
      CREATE TEMP TABLE system_configs (key text, value text);
      INSERT INTO system_configs VALUES ('new_member_threshold', '3000');
      CREATE TEMP TABLE client_wechat_users (
        user_id text PRIMARY KEY, name text, customer_type customer_type DEFAULT '流量客', member_level member_level,
        became_member_at timestamptz, updated_at timestamptz DEFAULT '2020-01-01T00:00:00Z',
        member_level_upgraded_at timestamptz, old_member_level member_level
      );
      CREATE TEMP TABLE sale_orders (
        sale_order_id text PRIMARY KEY, client_user_id text, paid_at timestamptz, created_at timestamptz,
        status text, sale_order_type text, received numeric, refunded_amount numeric
      );
      CREATE TEMP TABLE sale_items (
        sale_order_id text, sale_item_id text, received numeric, sale_amount numeric,
        is_experience boolean, item_direction text
      );
      CREATE TEMP TABLE sale_order_payments (id bigint, sale_order_id text, note text, change_type text, status text, paid_at timestamptz);
      CREATE TEMP TABLE sale_payment_item_receipts (sale_payment_id bigint, sale_order_id text, sale_item_id text, amount numeric);
      INSERT INTO client_wechat_users(user_id, customer_type, member_level, became_member_at) VALUES
        ('member','流量客',NULL,NULL), ('small','流量客',NULL,NULL), ('trial','流量客',NULL,NULL),
        ('nullpaid','流量客',NULL,NULL), ('empty','流量客',NULL,NULL), ('keep','会员客','金钻','2020-01-01T00:00:00Z');
      INSERT INTO sale_orders VALUES
        ('m','member', now()-interval '2 months', now()-interval '2 months','已完成','销售单',4000,0),
        ('s','small',now(),now(),'已支付','销售单',100,0),
        ('t','trial',now(),now(),'已支付','销售单',100,0),
        ('np','nullpaid',NULL,now(),'已完成','销售单',4000,0),
        ('ignored','empty',now(),now(),'待支付','销售单',9000,0);
      INSERT INTO sale_items VALUES ('t','ti',100,100,true,'购买');
    `)
    assert.deepEqual(await recalcCustomerTypesInTransaction(db), { typeCount: 4, levelCount: 2, becameCount: 2, selfCheck: { member_no_became: 0, member_no_level: 0, nonmember_with_level: 0 } })
    const first = (await db.query('SELECT * FROM client_wechat_users ORDER BY user_id')).rows
    const member = first.find(r => r.user_id === 'member')
    assert.equal(member.customer_type, '会员客')
    assert.equal(member.member_level, '初钻')
    assert.ok(member.became_member_at < new Date(Date.now() - 36*3600000))
    assert.equal(member.member_level_upgraded_at, null)
    assert.equal(member.old_member_level, null)
    const nullpaid = first.find(r => r.user_id === 'nullpaid')
    assert.equal(nullpaid.customer_type, '会员客')
    // paid_at 为空，同 cron 一样不算滚动消费 → 滚动档位低于门槛，
    // 但 #545 起会员客等级下限为初钻，不再留 NULL。
    assert.equal(nullpaid.member_level, '初钻')
    assert.equal(nullpaid.member_level_upgraded_at, null)
    assert.equal(first.find(r => r.user_id === 'small').customer_type, '小美客')
    assert.equal(first.find(r => r.user_id === 'trial').customer_type, '体验客')
    assert.equal(first.find(r => r.user_id === 'empty').updated_at.toISOString(), '2020-01-01T00:00:00.000Z')
    // #545（推翻 #257）：离线分类只升不降——现会员客不因计算档位更低而降档，
    // 历史等级/入会时间原样保留。
    const keep = first.find(r => r.user_id === 'keep')
    assert.equal(keep.customer_type, '会员客')
    assert.equal(keep.member_level, '金钻')
    assert.equal(keep.became_member_at.toISOString(), '2020-01-01T00:00:00.000Z')
    await db.query('DROP TABLE _recalc_target')
    assert.deepEqual(await recalcCustomerTypesInTransaction(db), { typeCount: 0, levelCount: 0, becameCount: 0, selfCheck: { member_no_became: 0, member_no_level: 0, nonmember_with_level: 0 } })
    assert.deepEqual((await db.query('SELECT * FROM client_wechat_users ORDER BY user_id')).rows, first)
    await db.query('ROLLBACK')
  } finally {
    await db.query('ROLLBACK').catch(() => {})
    await db.end()
  }
})
