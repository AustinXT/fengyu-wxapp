const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const automator = require("miniprogram-automator");
(async () => {
  const mp = await automator.launch({
    cliPath:
      process.env.WX_CLI_PATH ||
      "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
    projectPath: path.resolve(__dirname, ".."),
    args: process.env.WX_DEVTOOLS_PORT
      ? ["--port", process.env.WX_DEVTOOLS_PORT]
      : [],
    timeout: 45000,
  });
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 20000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw Error('UI 等待超时：' + label);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const exceptions = [];
  const savedWorkspace = await mp.evaluate(() => wx.getStorageSync("dailyWorkspace"));
  mp.on("exception", (e) => exceptions.push(e.message || String(e)));
  try {
    // 仅模拟器内拦截，测试完恢复；不写入正式代码或业务库。
    await mp.mockWxMethod("showModal", () => ({
      confirm: false,
      cancel: true,
    }));
    await mp.mockWxMethod('showToast', () => ({}));
    await mp.mockWxMethod("cloud.callFunction", (options) => {
      const date = new Date(Date.now() + 8 * 3600000)
        .toISOString()
        .slice(0, 10);
      const user = {
        employeeId: "UI-EMP",
        name: "测试员工",
        storeId: "UI-STORE",
        storeName: "测试门店",
        managerStores: globalThis.__dailyUiStoreManager === false ? [] : [{ store_id: "UI-STORE", store_name: "测试门店" }],
        scopedStores: [{ store_id: "UI-STORE", store_name: "测试门店" }],
        availableWorkspaces: ["employee", "manager", "management"],
        staffLevel: globalThis.__dailyUiMarket ? 'market' : "headquarters", positionName: "顾问", orgName: "测试总部",
        roleBindings: globalThis.__dailyUiStoreManager === false ? [] : [{role:"manager",roleName:"店长",scopeType:"门店",scopeName:"测试门店"}],
      };
      const entry = {
        businessType: "service",
        businessId: "UI-SVC",
        title: "测试顾客 · 面部护理",
        customer: "测试顾客",
        status: "已完成",
        items: [{ name: "面部护理", sourceOrderId: "UI-SALE", sessions: 1 }],
        feedback: "顾客体验良好",
        followUp: "三天后回访",
      };
      const period = { id: 'UI-PERIOD', name: '测试经营月', start: date.slice(0, 8) + '01', end: date.slice(0, 8) + '28', version: 1,
        weeks: [0, 1, 2, 3].map((i) => ({ id: 'w' + (i + 1), name: '第' + (i + 1) + '周', start: date.slice(0, 8) + String(i * 7 + 1).padStart(2, '0'), end: date.slice(0, 8) + String((i + 1) * 7).padStart(2, '0') })) };
      const summary = { due: 2, submitted: 1, missing: 1, rate: 50 }, range = { label: '今日', start: date, end: date, kind: 'today' };
      const dayActual = { sales: 5000, consumption: 6000, visits: 5, newCustomers: 2, projects: 7 };
      const weekActual = { sales: 15000, consumption: 12000, visits: 15, newCustomers: 4, projects: 20 };
      const monthActual = { sales: 30000, consumption: 25000, visits: 30, newCustomers: 9, projects: 42 };
      const snapshot = { scope: 'personal', scopeId: user.employeeId, period, day: dayActual,
        actuals: { day: dayActual, week: weekActual, month: monthActual },
        week: { name: '第1周' }, month: { start: period.start, end: period.end }, savedAt: new Date().toISOString() };
      let data;
      switch (options.data.action) {
        case 'period.list': data = { periods: [period], period, week: period.weeks[0] }; break;
        case 'target.read': data = { period, week: period.weeks[0], target: globalThis.__dailyUiTarget || null, reference: null }; break;
        case 'target.confirmMonth':
          globalThis.__dailyUiTarget = { sales: 10000, consumption: 20000, penalty: '认真复盘', month_confirmed: true, counts_month_confirmed: true, visits: 10, newCustomers: 0, projects: 20, version: 1,
            weeks: { w1: { sales: null, consumption: null }, w2: { sales: null, consumption: null }, w3: { sales: null, consumption: null }, w4: { sales: null, consumption: null } } };
          data = {}; break;
        case 'contacts.list': data = { contacts: [] }; break;
        case 'business.list': data = { entries: [] }; break;
        case 'pk.classes': data = { period, classes: [{ id: 'UI-CLASS', name: '测试班级', members: 1, stores: 1 }], scopeLabel: '排名仅统计授权门店' }; break;
        case 'pk.read': data = { period, week: period.weeks[0], scopeLabel: '排名仅统计授权门店', rows: [{ employeeId: user.employeeId, name: user.name, area: '测试市场', legion: '测试军团', group: '测试小组', mentor: '测试指导员', rank: 1,
          sales: { weekTarget: 10000, weekDone: 5000, monthTarget: 10000, monthDone: 5000 }, consumption: { weekTarget: 10000, weekDone: 6000, monthTarget: 10000, monthDone: 6000 },
          visits: { weekTarget: 10, weekDone: 4, monthTarget: 40, monthDone: 12 }, newCustomers: { weekTarget: 5, weekDone: 2, monthTarget: 20, monthDone: 6 }, projects: { weekTarget: 20, weekDone: 8, monthTarget: 80, monthDone: 24 } }] }; break;
        case 'management.read': data = { summary, range, markets: [{ id: 'UI-MARKET', name: '测试市场', ...summary }],
          stores: [{ store_id: 'UI-STORE', store_name: '测试门店', org_node_id: 'UI-MARKET', ...summary }],
          employees: [{ employee_id: user.employeeId, name: user.name, store_id: 'UI-STORE', store_name: '测试门店', position_name: '顾问', due: 2, submitted: 1 }],
          nodes: [{ id: 'UI-MARKET', name: '测试市场', type: '市场', parent_id: null }] }; break;
        case "auth.login":
          data = { user };
          break;
        case "report.status": data = { status: "draft" }; break;
        case "report.read":
          data = { date, report: globalThis.__dailyUiSubmitted ? { id: 'UI-REPORT', report_date: date, status: 'submitted', version: 1, action: '主动回访', growth: '总结经验', plan: '继续跟进' } : null, entries: [entry], metrics: snapshot, readOnly: false };
          break;
        case "report.save":
        case "report.submit":
          data = {
            report: {
              version: 1,
              status:
                options.data.action === "report.submit" ? "submitted" : "draft",
            },
          };
          break;
        case "report.history":
          data = {
            own: true, employee: { name: user.name, position_name: '顾问', store_name: '测试门店' }, summary,
            reports: [
              { id: "UI-REPORT", report_date: date, status: "submitted" },
            ],
          };
          break;
        case "manager.list":
          data = {
            date,
            reports: [
              {
                id: "UI-REPORT",
                employee_id: user.employeeId,
                employee_name: user.name,
              },
            ],
            unsubmitted: [], summary, range, employees: [{ employee_id: user.employeeId, name: user.name, due: 2, submitted: 1 }],
          };
          break;
        case "manager.detail":
          data = { own: true, canEdit: true,
            report: {
              id: "UI-REPORT",
              report_date: date,
              status: "submitted",
              employee_name: user.name,
              store_name: user.storeName, metric_snapshot: snapshot, period_snapshot: period, submitted_at: snapshot.savedAt,
              action: "主动回访",
              growth: "总结经验",
              plan: "继续跟进",
            },
            entries: [entry],
          };
          break;
        default:
          throw Error("Unexpected action");
      }
      return Promise.resolve({ result: { code: 0, message: "success", data } });
    });
    const output = path.resolve(__dirname, "../../_tmp/daily-ui");
    fs.mkdirSync(output, { recursive: true });
    await mp.evaluate(() => { globalThis.__dailyUiStoreManager = false; wx.setStorageSync("dailyWorkspace", "employee"); });
    const home = await mp.reLaunch("/pages/home/home");
    await wait(() => home.data("user"), "home");
    assert.equal((await home.data("user")).employeeId, "UI-EMP");
    await mp.screenshot({ path: path.join(output, "home.png") });
    const editor = await mp.navigateTo("/pages/report/report");
    await wait(() => editor.data("ready"), "editor");
    assert.equal((await editor.$$("textarea")).length, 5);
    await editor.callMethod("input", {
      detail: { value: "学习沟通技巧" },
      currentTarget: { dataset: { field: "growth" } },
    });
    assert.equal(await editor.data("dirty"), true);
    await editor.callMethod("save");
    assert.equal(await editor.data("version"), 1);
    assert.equal(await editor.data("dirty"), false);
    await mp.screenshot({ path: path.join(output, "report.png") });
    const manager = await mp.navigateTo("/pages/manager/manager");
    await wait(() => manager.data("ready"), "manager");
    assert.equal((await manager.data("reports")).length, 1);
    await mp.screenshot({ path: path.join(output, "manager.png") });
    const detail = await mp.navigateTo("/pages/detail/detail?id=UI-REPORT");
    await wait(() => detail.data("report"), "detail");
    assert.equal((await detail.data("entries"))[0].feedback, "顾客体验良好");
    assert.equal((await detail.$$("textarea")).length, 0);
    await mp.screenshot({ path: path.join(output, "detail.png") });
    const goal = await mp.navigateTo('/pages/goal/goal');
    await wait(() => goal.data('ready'), "goal");
    assert.equal(await goal.data('title'), '我的经营目标');
    assert.match(await goal.data('monthError'), /月目标/);
    for (const [field, value] of [['sales', '100'], ['consumption', '200'], ['visits', '10'], ['newCustomers', '0'], ['projects', '20'], ['penalty', '认真复盘']])
      await goal.callMethod('input', { currentTarget: { dataset: { field } }, detail: { value } });
    assert.equal(await goal.data('monthError'), '');
    await mp.mockWxMethod('showModal', () => ({ confirm: true, cancel: false }));
    await goal.callMethod('save', { currentTarget: { dataset: { kind: 'month' } } });
    assert.equal(await goal.data('confirmed'), true);
    assert.match(await goal.data('weekError'), /非负/);
    for (const [field, value] of [['weekSales', '120'], ['weekConsumption', '40'], ['weekVisits', '2'], ['weekNewCustomers', '0'], ['weekProjects', '3']])
      await goal.callMethod('input', { currentTarget: { dataset: { field } }, detail: { value } });
    assert.match(await goal.data('weekError'), /不能超过/);
    await goal.callMethod('input', { currentTarget: { dataset: { field: 'weekSales' } }, detail: { value: '20.01' } });
    assert.equal(await goal.data('weekError'), '');
    assert.equal(await goal.data('weekSalesPercent'), '20.0%');
    await mp.mockWxMethod('showModal', () => ({ confirm: false, cancel: true }));
    await mp.screenshot({ path: path.join(output, 'goal.png') });
    const history = await mp.navigateTo('/pages/history/history?employeeId=UI-EMP');
    await wait(() => history.data('ready'), 'history');
    assert.equal((await history.data('employee')).position_name, '顾问');
    assert.equal((await history.data('summary')).rate, 50);
    await mp.screenshot({ path: path.join(output, 'history.png') });
    await mp.navigateBack();
    const pk = await mp.navigateTo('/pages/pk/pk');
    await wait(() => pk.data('ready'), "pk");
    assert.equal((await pk.data('classes')).length, 1);
    await mp.screenshot({ path: path.join(output, 'pk-classes.png') });
    await pk.callMethod('openClass', { currentTarget: { dataset: { index: 0 } } });
    await wait(() => pk.data('ready'), "pk");
    assert.equal((await pk.data('rows'))[0].weekRate, '50.0%');
    await mp.screenshot({ path: path.join(output, 'pk-sales.png') });
    await pk.callMethod('metricChange', { currentTarget: { dataset: { metric: 'consumption' } } });
    await wait(() => pk.data('ready'), "pk");
    assert.equal((await pk.data('rows'))[0].weekRate, '60.0%');
    await mp.screenshot({ path: path.join(output, 'pk-consumption.png') });
    for (const [metric, done, rate] of [['visits', '4', '40.0%'], ['newCustomers', '2', '40.0%'], ['projects', '8', '40.0%']]) {
      await pk.callMethod('metricChange', { currentTarget: { dataset: { metric } } });
      await wait(() => pk.data('ready'), `pk-${metric}`);
      assert.equal((await pk.data('rows'))[0].weekDoneText, done);
      assert.equal((await pk.data('rows'))[0].weekRate, rate);
    }
    await mp.evaluate(() => wx.setStorageSync('dailyWorkspace', 'manager'));
    await mp.evaluate(() => { globalThis.__dailyUiStoreManager = true; });
    const storeWorkbench = await mp.reLaunch('/pages/workbench/workbench');
    await wait(() => storeWorkbench.data('ready'), "storeWorkbench");
    assert.equal(await storeWorkbench.data('workspace'), 'manager');
    await mp.screenshot({ path: path.join(output, 'store-workbench.png') });
    await mp.evaluate(() => wx.setStorageSync('dailyWorkspace', 'management'));
    const overview = await mp.reLaunch('/pages/home/home');
    await wait(() => overview.data('overview'), "overview");
    assert.equal((await overview.data('overview')).markets[0].missing, 1);
    await mp.screenshot({ path: path.join(output, 'management.png') });
    await mp.evaluate(() => { globalThis.__dailyUiMarket = true; });
    const marketOverview = await mp.reLaunch('/pages/home/home');
    await wait(() => marketOverview.data('overview'), '市场角色总览');
    assert.equal((await marketOverview.data('user')).staffLevel, 'market');
    await mp.screenshot({ path: path.join(output, 'market-overview.png') });
    await mp.evaluate(() => { delete globalThis.__dailyUiMarket; });
    const org = await mp.reLaunch('/pages/workbench/workbench');
    await wait(() => org.data('ready'), "org");
    await org.callMethod('orgChange', { currentTarget: { dataset: { view: 'people' } } });
    await org.callMethod('position', { currentTarget: { dataset: { value: '养生师' } } });
    assert.equal((await org.data('visibleEmployees')).length, 0);
    await org.callMethod('position', { currentTarget: { dataset: { value: '顾问' } } });
    assert.equal((await org.data('visibleEmployees')).length, 1);
    await mp.screenshot({ path: path.join(output, 'organization.png') });
    const rangePage = await mp.navigateTo('/pages/range/range?nodeId=UI-MARKET&period=week');
    await wait(() => rangePage.data('overview'), "rangePage");
    assert.equal(await rangePage.data('period'), 'week');
    await mp.screenshot({ path: path.join(output, 'market-detail.png') });
    const mine = await mp.reLaunch('/pages/mine/mine');
    await wait(() => mine.data('user'), "mine");
    await mp.screenshot({ path: path.join(output, 'mine.png') });
    await mp.evaluate(() => { globalThis.__dailyUiSubmitted = true; globalThis.__dailyUiStoreManager = false; wx.setStorageSync('dailyWorkspace', 'employee'); });
    await mp.navigateTo('/pages/report/report');
    await wait(async () => (await mp.currentPage()).path === 'pages/detail/detail', '本人提交后只读详情');
    const ownDetail = await mp.currentPage();
    await wait(() => ownDetail.data('report'), '本人详情数据');
    assert.equal(await ownDetail.data('canEdit'), true);
    await ownDetail.callMethod('edit');
    await wait(async () => (await mp.currentPage()).path === 'pages/report/report', '当天修改');
    const editToday = await mp.currentPage();
    await wait(() => editToday.data('ready'), '当天修改数据');
    assert.equal(await editToday.data('status'), 'submitted');
    await mp.screenshot({ path: path.join(output, 'edit-today.png') });
    await editToday.callMethod('cancelEdit');
    await wait(async () => (await mp.currentPage()).path === 'pages/detail/detail', '取消修改返回只读');
    assert.deepEqual(exceptions, []);
    console.log(
      "UI 验证通过：三套工作台、市场角色、填写保存、只读详情、目标校验、个人记录、PK五项榜单、组织筛选和市场详情（模拟接口）",
    );
  } finally {
    await mp.evaluate(() => { delete globalThis.__dailyUiSubmitted; delete globalThis.__dailyUiTarget; delete globalThis.__dailyUiMarket; delete globalThis.__dailyUiStoreManager; });
    await mp.evaluate((workspace) => wx.setStorageSync("dailyWorkspace", workspace), savedWorkspace);
    await mp.restoreWxMethod("cloud.callFunction");
    await mp.restoreWxMethod("showModal");
    await mp.restoreWxMethod('showToast');
    await mp.reLaunch("/pages/home/home");
    mp.disconnect();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
