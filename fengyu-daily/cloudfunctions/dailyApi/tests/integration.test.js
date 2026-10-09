const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const url = require('./test-database').testDatabase();
const pg = require("../db/pg");
const auth = require("../routes/auth"),
  report = require("../routes/report"),
  manager = require("../routes/manager");
const { today } = require("../utils/validation");
test("真实 PG 最小闭环、归属、并发和门店权限", { skip: !url }, async (t) => {
  const prefix = "dt" + randomUUID().slice(0, 6),
    a = prefix + "a",
    b = prefix + "b",
    c = prefix + "c",
    s1 = prefix + "s1",
    s2 = prefix + "s2",
    n1 = prefix + "n1",
    n2 = prefix + "n2",
    role = prefix + "role";
  const phone =
    "139" + String(Math.floor(Math.random() * 10000000)).padStart(7, "0");
  const day = today(),
    old = "2025-01-01",
    currentPeriodId = prefix + 'current-period',
    appid = "wx4da3e1e9ad861396",
    ident = { appid, openid: prefix + "wx" };
  const addDays = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  const user = {
    employeeId: a,
    name: "测试员工",
    storeId: s1,
    storeName: "测试门店",
    managerStores: [],
  };
  const ctx = (payload = {}, u = user) => ({
    event: { payload },
    auth: u,
    result: null,
  });
  async function run(fn, payload, u) {
    const x = ctx(payload, u);
    await fn(x);
    return x.result;
  }
  const order1 = prefix + "o1",
    order2 = prefix + "o2",
    order3 = prefix + "o3",
    item1 = prefix + "i1",
    item2 = prefix + "i2",
    item3 = prefix + "i3",
    service = prefix + "svc";
  const bindCtx = (id, phone) => ({
    identity: id,
    event: { payload: { code: "wechat-one-time-code" } },
    cloud: {
      openapi: {
        phonenumber: {
          getPhoneNumber: async () => ({
            phoneInfo: { purePhoneNumber: phone },
          }),
        },
      },
    },
  });
  try {
    await pg.query("INSERT INTO org_nodes(id,name,type) VALUES($1,$1,'总部')", [
      prefix + "hq",
    ]);
    await pg.query(
      "INSERT INTO org_nodes(id,name,type,parent_id) VALUES($1,$1,'市场',$2)",
      [prefix + "market", prefix + "hq"],
    );
    await pg.query(
      "INSERT INTO org_nodes(id,name,type,parent_id) VALUES($1,$1,'门店',$3),($2,$2,'门店',$3)",
      [n1, n2, prefix + "market"],
    );
    await pg.query(
      "INSERT INTO stores(store_id,store_name,org_node_id) VALUES($1,$1,$2),($3,$3,$4)",
      [s1, n1, s2, n2],
    );
    await pg.query(
      "INSERT INTO staff_wechat_users(employee_id,name,phone,openid,store_id) VALUES($1,'测试员工',$6,$9,$4),($2,'另一员工',$7,NULL,$4),($3,'其他门店',$8,NULL,$5)",
      [
        a,
        b,
        c,
        s1,
        s2,
        phone + "1",
        phone + "2",
        phone + "3",
        prefix + "staff",
      ],
    );
    await pg.query(
      "INSERT INTO permission_role_definitions(role_key,name,is_store_manager) VALUES($1,$1,true)",
      [role],
    );
    await pg.query(
      "INSERT INTO permission_roles(employee_id,role,scope_id) VALUES($1,$2,$3)",
      [a, role, n1],
    );
    for (const [id, item, name] of [
      [order1, item1, "服务来源项目"],
      [order2, item2, "独立销售项目"],
      [order3, item3, "他人销售项目"],
    ]) {
      await pg.query(
        `INSERT INTO sale_orders(sale_order_id,status,market_name,store_id,sale_order_datetime,total_amount,payment_method,customer_name,performance_attribution_date)
    VALUES($1,'已支付','测试市场',$2,NOW(),100,'线下','测试顾客',$3)`,
        [id, s1, day],
      );
      await pg.query(
        `INSERT INTO sale_items(sale_item_id,sale_order_id,store_id,product_name,unit_price,unit_real_price,sale_amount,received)
    VALUES($1,$2,$3,$4,100,100,100,100)`,
        [item, id, s1, name],
      );
      const [payment] = await pg.query(
        `INSERT INTO sale_order_payments(sale_order_id,change_type,amount,payment_method,status,source_end,paid_at)
    VALUES($1,'首次支付',100,'线下','已支付','staff',NOW()) RETURNING id`,
        [id],
      );
      const [receipt] = await pg.query(
        `INSERT INTO sale_payment_item_receipts(sale_payment_id,sale_order_id,sale_item_id,amount) VALUES($1,$2,$3,100) RETURNING id`,
        [payment.id, id, item],
      );
      await pg.query(
        `INSERT INTO sale_payment_item_allocations(sale_payment_item_receipt_id,employee_id,role_type,allocation_ratio,allocated_amount)
    VALUES($1,$2,'美容师',1,100)`,
        [receipt.id, id === order3 ? b : a],
      );
    }
    // 指派员工 B，实际服务明细员工 A：以实际参与归属为准。
    await pg.query(
      `INSERT INTO service_orders(service_order_id,status,market_name,store_id,service_date,assigned_employee_id) VALUES($1,'已完成','测试市场',$2,$3,$4)`,
      [service, s1, day, b],
    );
    await pg.query(
      `INSERT INTO service_items(service_item_id,sale_item_id,service_order_id,session_used,employee_id) VALUES($1,$2,$3,1,$4)`,
      [prefix + "si", item1, service, a],
    );
    await pg.query('UPDATE service_items SET unit_real_price=50 WHERE service_item_id=$1', [prefix + 'si']);
    await pg.query(`INSERT INTO service_commissions(service_item_id,employee_id,role_type,allocation_ratio,commission_rate,commission_amount)
      VALUES($1,$2,'美容师',0.6,0,0),($1,$3,'养生师',0.4,0,0)`, [prefix + 'si', a, b]);
    await t.test('金额沿用员工分配与门店实际口径，排除寄存退款消耗', async () => {
      const metrics = require('../routes/metrics');
      const personal = await run(metrics.read, { date: day });
      assert.equal(personal.day.sales, 20000);
      assert.equal(personal.day.consumption, 3000);
      const store = await run(metrics.read, { date: day, scope: 'store', scopeId: s1 },
        { ...user, managerStores: [{ store_id: s1 }] });
      assert.equal(store.day.sales, 30000);
      assert.equal(store.day.consumption, 5000);
      const { DEPOSIT_REFUND_REMARK } = require('../utils/consume-filter');
      await pg.query('UPDATE service_orders SET remark=$2 WHERE service_order_id=$1', [service, DEPOSIT_REFUND_REMARK]);
      assert.equal((await run(metrics.read, { date: day })).day.consumption, 0);
      await pg.query('UPDATE service_orders SET remark=NULL WHERE service_order_id=$1', [service]);
    });
    await t.test('五项实际数按参与员工去重，首次到店查完整历史，退款不计数', async () => {
      const { series, marketNewCustomers } = require('../utils/operating-series');
      const client = prefix+'counts-client', earlier = prefix+'counts-old', cross = prefix+'counts-cross';
      const yesterday = new Date(Date.parse(day+'T12:00:00Z')-86400000).toISOString().slice(0,10);
      try {
        await pg.query('INSERT INTO client_wechat_users(user_id,name) VALUES($1,$2)',[client,client]);
        await pg.query('UPDATE service_orders SET client_user_id=$2 WHERE service_order_id=$1',[service,client]);
        await pg.query(`INSERT INTO service_commissions(service_item_id,employee_id,role_type,allocation_ratio,commission_rate,commission_amount) VALUES($1,$2,'养生师',0,0,0)`,[prefix+'si',a]);
        await pg.query(`INSERT INTO service_orders(service_order_id,status,market_name,store_id,service_date,client_user_id,assigned_employee_id) VALUES($1,'已完成','测试市场',$2,$3,$4,$5)`,[earlier,s2,yesterday,client,a]);
        await pg.query('UPDATE service_items SET session_used=2 WHERE service_item_id=$1',[prefix+'si']);
        const input={storeIds:[s1,s2],employeeIds:[a,b],start:day,end:day};
        let events=await series(pg.query,input);
        const own=events.find(r=>r.scope==='personal'&&r.id===a);
        assert.equal(own.visits,1);assert.equal(own.projects,2);assert.equal(own.newCustomers,0);
        assert.equal(events.find(r=>r.scope==='store'&&r.id===s1).visits,1);
        await pg.query('DELETE FROM service_orders WHERE service_order_id=$1',[earlier]);
        await pg.query(`INSERT INTO service_orders(service_order_id,status,market_name,store_id,service_date,client_user_id,assigned_employee_id) VALUES($1,'已完成','测试市场',$2,$3,$4,$5)`,[cross,s2,day,client,a]);
        events=await series(pg.query,input);assert.equal(events.find(r=>r.scope==='personal'&&r.id===a).newCustomers,1);
        const first=await marketNewCustomers(pg.query,[s1,s2],day,day);assert.equal(new Set(first.map(r=>r.client_user_id)).size,1);
        const { DEPOSIT_REFUND_REMARK }=require('../utils/consume-filter');
        await pg.query('UPDATE service_orders SET remark=$2 WHERE service_order_id=$1',[service,DEPOSIT_REFUND_REMARK]);
        events=await series(pg.query,input);assert.ok(!events.some(r=>r.scope==='personal'&&r.id===a&&r.visits));
      } finally {
        await pg.query('UPDATE service_items SET session_used=1 WHERE service_item_id=$1',[prefix+'si']);
        await pg.query('UPDATE service_orders SET client_user_id=NULL,remark=NULL WHERE service_order_id=$1',[service]);
        await pg.query('DELETE FROM service_commissions WHERE service_item_id=$1 AND employee_id=$2 AND role_type=$3',[prefix+'si',a,'养生师']);
        await pg.query('DELETE FROM service_orders WHERE service_order_id=ANY($1::text[])',[[earlier,cross]]);
        await pg.query('DELETE FROM client_wechat_users WHERE user_id=$1',[client]);
      }
    });
    await t.test("手机号验证后独立绑定，员工端 OPENID 保持不变", async () => {
      await auth.bindPhone(bindCtx(ident, phone + "1"));
      const [staff] = await pg.query(
        "SELECT openid FROM staff_wechat_users WHERE employee_id=$1",
        [a],
      );
      assert.equal(staff.openid, prefix + "staff");
      const u = await auth.requireUser(ident);
      assert.equal(u.employeeId, a);
      assert.equal(u.managerStores[0].store_id, s1);
    });
    await t.test("拒绝伪造手机号、重复绑定和跨 AppID 身份", async () => {
      await assert.rejects(
        () =>
          auth.bindPhone({
            ...bindCtx(ident, phone + "1"),
            event: {
              payload: { phone: phone + "1" },
              phoneData: {
                data: { purePhoneNumber: phone + "1", watermark: { appid } },
              },
            },
          }),
        /INVALID_PARAMS/,
      );
      await assert.rejects(
        () =>
          auth.bindPhone(bindCtx({ appid, openid: "another-wx" }, phone + "1")),
        /CONFLICT/,
      );
      assert.equal(await auth.requireUser(ident).then((x) => x.employeeId), a);
    });
    await t.test('先设置五项目标，再进入日报填写流程', async () => {
      const weeks = [0, 1, 2, 3].map((i) => ({ id: 'w' + (i + 1), name: '第' + (i + 1) + '周',
        start: addDays(day, i * 7), end: addDays(day, i * 7 + 6) }));
      await pg.query(`INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks)
        VALUES($1,'闭环测试经营月',$2,$3,$4::jsonb)`,
      [currentPeriodId, day, addDays(day, 27), JSON.stringify(weeks)]);
      const target = require('../routes/target');
      const targetCtx = (payload) => ({ auth: user, event: { payload: {
        scope: 'personal', periodId: currentPeriodId, periodVersion: 1, ...payload,
      } } });
      await target.confirmMonth(targetCtx({ version: 0, sales: '500', consumption: '200',
        visits: '40', newCustomers: '10', projects: '80', penalty: '真实库闭环验证' }));
      await target.saveWeek(targetCtx({ version: 1, sales: '125', consumption: '50',
        visits: '10', newCustomers: '2', projects: '20' }));
      const read = targetCtx({ date: day });
      await target.read(read);
      assert.equal(read.result.target.sales, 50000);
      assert.equal(read.result.target.weeks.w1.visits, 10);
      assert.equal(read.result.target.weeks.w1.newCustomers, 2);
      assert.equal(read.result.target.weeks.w1.projects, 20);
    });
    assert.equal((await run(report.status, { date: day })).status, null);
    let editor = await run(report.read, { date: day });
    await t.test(
      "自动列出实际服务和独立销售；排除服务来源销售、他人销售",
      () => {
        assert.deepEqual(
          new Set(editor.entries.map((e) => e.businessId)),
          new Set([service, order2]),
        );
        assert.equal(
          editor.entries.find((e) => e.businessId === service).items[0]
            .sourceOrderId,
          order1,
        );
      },
    );
    let payload = {
      date: day,
      version: 0,
      entries: editor.entries.map((e) => ({
        ...e,
        feedback: "顾客满意",
        followUp: "下周回访",
      })),
      action: "主动回访",
      growth: "记录经验",
      plan: "继续跟进",
    };
    await t.test("拒绝注入其他员工业务", async () => {
      await assert.rejects(
        () =>
          run(report.save, {
            ...payload,
            entries: [
              ...payload.entries,
              { businessType: "sale", businessId: order3 },
            ],
          }),
        /CONFLICT/,
      );
    });
    const olderService = prefix + 'manual-svc';
    await pg.query(`INSERT INTO service_orders(service_order_id,status,market_name,store_id,service_date,assigned_employee_id)
      VALUES($1,'已完成','测试市场',$2,$3,$4)`, [olderService, s1, day, a]);
    await pg.query(`INSERT INTO service_items(service_item_id,sale_item_id,service_order_id,session_used,employee_id,unit_real_price)
      VALUES($1,$2,$3,1,$4,50)`, [prefix + 'manual-item', item1, olderService, a]);
    payload.entries.push({ businessType: 'service', businessId: olderService, businessDate: day, auto: false, feedback: '补录反馈', followUp: '补录跟进' });
    payload.mentorEmployeeId = b;
    let saved = await run(report.save, payload);
    await t.test('手动补充回读、移除及指导关系校验', async () => {
      await assert.rejects(run(require('../routes/business').list, { date: day, sourceDate: old }), /INVALID_PARAMS/);
      await assert.rejects(run(report.save, { ...payload, version: saved.report.version, entries: [...payload.entries, { businessType: 'sale', businessId: 'old', businessDate: old }] }), /INVALID_PARAMS/);
      const stored = await run(report.read, { date: day });
      assert.equal(stored.entries.find((e) => e.businessId === olderService).auto, false);
      assert.equal(stored.entries.find((e) => e.businessId === olderService).feedback, '补录反馈');
      assert.equal(stored.report.mentor_employee_id, b);
      await assert.rejects(run(report.save, { ...payload, version: saved.report.version, mentorEmployeeId: c }), /PERMISSION_DENIED/);
      payload.entries = payload.entries.filter((e) => e.businessId !== olderService);
      saved = await run(report.save, { ...payload, version: saved.report.version });
      assert.equal((await run(report.read, { date: day })).entries.some((e) => e.businessId === olderService), false);
    });
    const boss = { ...user, managerStores: [{ store_id: s1, store_name: s1 }] };
    await t.test("草稿回读；店长看不到草稿详情", async () => {
      editor = await run(report.read, { date: day });
      assert.equal(editor.entries.find((e) => e.businessId === service).feedback, "顾客满意");
      assert.equal(editor.report.plan, "继续跟进");
      assert.deepEqual(await run(report.status, { date: day }), { status: "draft" });
      assert.equal((await run(report.status, { date: day }, { ...user, employeeId: b })).status, null);
      const list = await run(manager.list, { date: day, storeId: s1 }, boss);
      assert.equal(list.reports.length, 0);
      await assert.rejects(
        () => run(manager.detail, { id: saved.report.id }, boss),
        /NOT_FOUND/,
      );
      assert.equal(
        (await run(report.read, { date: day }, { ...user, employeeId: b }))
          .report,
        null,
      );
    });
    payload.version = saved.report.version;
    await t.test("并发提交只有一个成功，另一个版本冲突", async () => {
      const results = await Promise.allSettled([
        run(report.submit, payload),
        run(report.submit, payload),
      ]);
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      assert.match(
        results.find((x) => x.status === "rejected").reason.message,
        /CONFLICT/,
      );
    });
    await t.test("本人和店长可查看已提交日报；其他员工和跨店不可查看", async () => {
      const list = await run(manager.list, { date: day, storeId: s1 }, boss);
      assert.equal(list.reports.length, 1);
      const detail = await run(manager.detail, { id: saved.report.id }, boss);
      assert.equal(detail.entries[0].feedback, "顾客满意");
      const own = await run(manager.detail, { date: day }, user);
      assert.equal(own.own, true); assert.equal(own.canEdit, day === require('../utils/validation').today());
      assert.equal(own.report.id, saved.report.id);
      await assert.rejects(run(manager.detail, { date: day }, { ...user, employeeId: b }), /NOT_FOUND/);
      assert.equal(detail.report.metric_snapshot.day.consumption, 10000);
      assert.equal(detail.report.metric_snapshot.scope, 'store');
      await assert.rejects(
        () => run(manager.list, { date: day, storeId: s2 }, boss),
        /PERMISSION_DENIED/,
      );
      await assert.rejects(
        () => run(manager.detail, { id: saved.report.id }, { ...user, employeeId: b }),
        /NOT_FOUND/,
      );
    });
    await t.test("提交后业务快照不随业务名称变化；不能改回草稿", async () => {
      assert.deepEqual(await run(report.status, { date: day }), { status: "submitted" });
      const frozen = (await run(report.read, { date: day })).metrics;
      await pg.query('UPDATE service_items SET unit_real_price=80 WHERE service_item_id=$1', [prefix + 'si']);
      assert.equal((await run(require('../routes/metrics').read, { date: day })).day.consumption, 4800);
      assert.deepEqual((await run(report.read, { date: day })).metrics, frozen);
      await pg.query(
        "UPDATE sale_items SET product_name=$1 WHERE sale_item_id=$2",
        ["改名项目", item2],
      );
      const result = await run(report.read, { date: day });
      assert.match(
        result.entries.find((e) => e.businessId === order2).title,
        /独立销售项目/,
      );
      await assert.rejects(
        () => run(report.save, { ...payload, version: result.report.version }),
        /INVALID_STATE/,
      );
      const next = await run(report.submit, {
        ...payload,
        version: result.report.version,
        plan: "新的计划",
      });
      assert.equal(next.report.plan, "新的计划");
    });
    await t.test("历史提交后只读，不允许二次提交", async () => {
      const historical = await run(report.submit, {
        ...payload,
        date: old,
        version: 0,
        entries: [],
      });
      assert.equal((await run(report.read, { date: old })).readOnly, true);
      await assert.rejects(
        () =>
          run(report.submit, {
            ...payload,
            date: old,
            version: historical.report.version,
            entries: [],
          }),
        /INVALID_STATE/,
      );
    });
    await t.test('管理总览按授权组织筛选；已交一日不能掩盖范围内其他缺交日', async () => {
      const management = require('../routes/management');
      const admin = { ...user, availableWorkspaces: ['management'], scopeOrgNodeIds: [prefix + 'hq', prefix + 'market', n1, n2],
        scopedStores: [{ store_id: s1, store_name: s1, org_node_id: n1 }, { store_id: s2, store_name: s2, org_node_id: n2 }] };
      const first = await run(management.read, { nodeId: n1 }, admin);
      assert.deepEqual(first.stores.map((s) => s.store_id), [s1]);
      assert.equal(first.summary.due, 2); assert.equal(first.summary.submitted, 1); assert.equal(first.summary.missing, 1);
      const second = await run(management.read, { nodeId: n2 }, admin);
      assert.equal(second.employees.length, 1); assert.equal(second.summary.submitted, 0);
      await assert.rejects(run(management.read, { nodeId: 'outside' }, admin), /PERMISSION_DENIED/);
    });
    await t.test('经营月个人记录、PK授权范围、门店及整月目标使用真实PG', async () => {
      const periodId = prefix + 'period', classId = prefix + 'class';
      const weeks = [0, 1, 2, 3].map((i) => ({ id: 'w' + (i + 1), name: '第' + (i + 1) + '周',
        start: '2025-01-' + String(i * 7 + 1).padStart(2, '0'), end: '2025-01-' + String((i + 1) * 7).padStart(2, '0') }));
      await pg.query(`INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks) VALUES($1,'测试经营月','2025-01-01','2025-01-28',$2::jsonb)`, [periodId, JSON.stringify(weeks)]);
      await pg.query('INSERT INTO daily_pk_classes(id,period_id,name) VALUES($1,$2,$3)', [classId, periodId, classId]);
      await pg.query(`INSERT INTO daily_pk_stores(period_id,store_id,class_id) VALUES($1,$2,$4),($1,$3,$4)`, [periodId, s1, s2, classId]);
      await pg.query(`INSERT INTO daily_operating_targets(period_id,scope,scope_id,sales,consumption,weeks,month_confirmed)
        VALUES($1,'personal',$2,10000,20000,$3::jsonb,true)`, [periodId, a, JSON.stringify({ w1: { sales: 1000, consumption: 2000 }, w2: { sales: 2000, consumption: 3000 }, w3: { sales: 3000, consumption: 4000 } })]);
      try {
        const h = await run(report.history, { periodId });
        assert.equal(h.reports.length, 1); assert.equal(h.reports[0].report_date, old);
        const initialized = await run(report.history, { periodId, includePeriods: true });
        assert.deepEqual(initialized.reports, h.reports);
        assert.deepEqual(initialized.summary, h.summary);
        assert.equal(initialized.period.id, periodId);
        assert.ok(initialized.periods.some(p => p.id === periodId));
        assert.equal((await run(report.history, { limit: 2 })).reports.length <= 2, true);
        const other = await run(report.history, { employeeId: a, periodId }, { ...boss, employeeId: b });
        assert.equal(other.own, false); assert.ok(other.reports.every((r) => r.status === 'submitted'));
        await assert.rejects(run(report.history, { employeeId: c }, boss), /NOT_FOUND/);
        const pk = require('../routes/pk');
        const klass = await run(pk.classes, { periodId });
        assert.equal(klass.classes[0].members, 3);
        const board = await run(pk.read, { periodId, classId, date: '2025-01-15' });
        assert.deepEqual(new Set(board.rows.map((r) => r.employeeId)), new Set([a, b, c]));
        assert.equal(board.rows.find((r) => r.employeeId === a).scope, 'store');
        assert.equal(board.rows.find((r) => r.employeeId === a).sales.monthTarget, null);
        await pg.query(`INSERT INTO daily_operating_targets(period_id,scope,scope_id,sales,consumption,weeks,month_confirmed)
          VALUES($1,'store',$2,10000,20000,$3::jsonb,true)`, [periodId,s1,JSON.stringify({w1:{sales:1000,consumption:2000},w2:{sales:2000,consumption:3000},w3:{sales:3000,consumption:4000}})]);
        const scopedBoard = await run(pk.read,{periodId,classId,date:'2025-01-15'});
        assert.equal(scopedBoard.rows.find(r=>r.employeeId===a).sales.monthTarget,10000);
        assert.equal(scopedBoard.rows.find((r) => r.employeeId === a).consumption.weekTarget, 4000);
        assert.equal(scopedBoard.rows.find((r) => r.employeeId === a).consumption.monthTarget, 20000);
        assert.ok(board.rows.find((r) => r.employeeId === a).storeName);
        const last = await run(pk.read, { periodId, classId, date: '2025-01-25', metric: 'consumption' });
        assert.equal(last.rows.find((r) => r.employeeId === a).sales.weekTarget, 4000);
        assert.equal(last.rows.find((r) => r.employeeId === a).sales.monthTarget, 10000);
        await assert.rejects(run(pk.read, { periodId, classId }, { ...user, storeId: null }), /NOT_FOUND/);
        const month = await run(manager.list, { storeId: s1, periodId, date: '2025-01-28', period: 'month' }, boss);
        assert.equal(month.range.start, '2025-01-01'); assert.equal(month.range.end, '2025-01-28');
        assert.equal(month.reports.length, 1);
      } finally {
        await pg.query('DELETE FROM daily_pk_stores WHERE period_id=$1', [periodId]);
        await pg.query('DELETE FROM daily_pk_classes WHERE period_id=$1', [periodId]);
        await pg.query('DELETE FROM daily_operating_targets WHERE period_id=$1', [periodId]);
        await pg.query('DELETE FROM daily_operating_periods WHERE id=$1', [periodId]);
      }
    });
    await t.test('初始化合并保持跨市场观看者特殊周期，结果与原两次调用一致', async () => {
      const globalId = prefix + 'bootstrap-global', specialId = prefix + 'bootstrap-special', market2 = prefix + 'market2';
      await pg.query("INSERT INTO org_nodes(id,name,type,parent_id) VALUES($1,$1,'市场',$2)", [market2, prefix + 'hq']);
      await pg.query('UPDATE org_nodes SET parent_id=$1 WHERE id=$2', [market2, n2]);
      const viewer = { ...user, availableWorkspaces: ['management'], scopedStores: [{ store_id: s1 }, { store_id: s2 }] };
      try {
        const weeks = [{ id: 'w', name: '经营周', start: '2025-01-01', end: '2025-01-28' }];
        await pg.query(`INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks,month_key)
          VALUES($1,'默认月份','2025-01-01','2025-01-28',$2::jsonb,'2025-01')`, [globalId, JSON.stringify(weeks)]);
        await pg.query(`INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks,region_id,month_key)
          VALUES($1,'市场特殊月份','2025-01-01','2025-01-25',$2::jsonb,$3,'2025-01')`,
          [specialId, JSON.stringify([{ ...weeks[0], end: '2025-01-25' }]), prefix + 'market']);
        await pg.query('INSERT INTO daily_operating_period_stores(period_id,store_id) VALUES($1,$2)', [specialId,s1]);
        const periodRoute = require('../routes/period');
        const priorList = await run(periodRoute.list, { date: '2025-01-15' }, viewer);
        const otherList = await run(periodRoute.list, { date: '2025-01-15' }, { ...viewer, employeeId: c, storeId: s2 });
        assert.equal(priorList.period.id,specialId);assert.equal(otherList.period.id,globalId);
        const old = await run(report.history, { employeeId: c, periodId: priorList.period.id, date: '2025-01-15' }, viewer);
        const initialized = await run(report.history, { employeeId: c, includePeriods: true, date: '2025-01-15' }, viewer);
        assert.equal(initialized.period.id,specialId);
        assert.deepEqual(initialized.reports,old.reports);assert.deepEqual(initialized.summary,old.summary);
        assert.deepEqual(initialized.periods,priorList.periods);
      } finally {
        await pg.query('DELETE FROM daily_operating_period_stores WHERE period_id=$1', [specialId]);
        await pg.query('DELETE FROM daily_operating_periods WHERE id=ANY($1::text[])', [[globalId,specialId]]);
        await pg.query('UPDATE org_nodes SET parent_id=$1 WHERE id=$2', [prefix + 'market',n2]);
        // 市场触发的库存关联随本次私有测试数据库一起销毁。
      }
    });
    await t.test('空市场授权沿用员工端入口规则，只返回授权空范围', async () => {
      await pg.query("INSERT INTO org_nodes(id,name,type,parent_id) VALUES($1,$1,'市场',$2)", [prefix + 'empty-market', prefix + 'hq']);
      await pg.query("INSERT INTO permission_role_definitions(role_key,name,actions) VALUES($1,$1,$2::text[])", [prefix + 'market-role', ['data_center:dashboard']]);
      await pg.query('DELETE FROM permission_roles WHERE employee_id=$1', [a]);
      await pg.query('INSERT INTO permission_roles(employee_id,role,scope_id) VALUES($1,$2,$3)', [a, prefix + 'market-role', prefix + 'empty-market']);
      require('../utils/permission-matrix').invalidatePermissionMatrixCache();
      const empty = await auth.requireUser(ident);
      assert.deepEqual(empty.availableWorkspaces, ['employee', 'manager', 'management']);
      assert.equal(empty.scopedStores.length, 0);
      const overview = await run(require('../routes/management').read, {}, empty);
      assert.equal(overview.summary.due, 0);
      assert.equal(overview.stores.length, 0);
      assert.deepEqual(overview.nodes.map((node) => node.id), [prefix + 'empty-market']);
      await assert.rejects(run(require('../routes/management').read, { nodeId: prefix + 'market' }, empty), /PERMISSION_DENIED/);
    });
    await t.test("角色撤销立即生效；离职立即禁止登录", async () => {
      await pg.query("DELETE FROM permission_roles WHERE employee_id=$1", [a]);
      assert.equal((await auth.requireUser(ident)).managerStores.length, 0);
      await pg.query(
        "UPDATE staff_wechat_users SET is_resigned=true,resigned_at=CURRENT_DATE WHERE employee_id=$1",
        [a],
      );
      await assert.rejects(() => auth.requireUser(ident), /PERMISSION_DENIED/);
    });
  } finally {
    await pg.query('DELETE FROM daily_operating_targets WHERE period_id=$1', [currentPeriodId]);
    await pg.query('DELETE FROM daily_operating_periods WHERE id=$1', [currentPeriodId]);
    // 独立临时库将在验证结束销毁；关闭连接，避免 node:test 挂起。
    await pg.getPool().end();
  }
});
