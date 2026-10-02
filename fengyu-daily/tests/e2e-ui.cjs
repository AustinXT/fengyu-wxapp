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
  const exceptions = [];
  mp.on("exception", (e) => exceptions.push(e.message || String(e)));
  try {
    // 仅模拟器内拦截，测试完恢复；不写入正式代码或业务库。
    await mp.mockWxMethod("showModal", () => ({
      confirm: false,
      cancel: true,
    }));
    await mp.mockWxMethod("cloud.callFunction", (options) => {
      const date = new Date(Date.now() + 8 * 3600000)
        .toISOString()
        .slice(0, 10);
      const user = {
        employeeId: "UI-EMP",
        name: "测试员工",
        storeId: "UI-STORE",
        storeName: "测试门店",
        managerStores: [{ store_id: "UI-STORE", store_name: "测试门店" }],
        scopedStores: [{ store_id: "UI-STORE", store_name: "测试门店" }],
        availableWorkspaces: ["employee", "manager"],
        staffLevel: "store_manager",
        roleBindings: [{role:"manager",roleName:"店长",scopeType:"门店",scopeName:"测试门店"}],
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
      let data;
      switch (options.data.action) {
        case "auth.login":
          data = { user };
          break;
        case "report.read":
          data = { date, report: null, entries: [entry], readOnly: false };
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
            unsubmitted: [],
          };
          break;
        case "manager.detail":
          data = {
            report: {
              id: "UI-REPORT",
              report_date: date,
              status: "submitted",
              employee_name: user.name,
              store_name: user.storeName,
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
    const home = await mp.reLaunch("/pages/home/home");
    await home.waitFor(() => home.data("user"));
    assert.equal((await home.data("user")).employeeId, "UI-EMP");
    await mp.screenshot({ path: path.join(output, "home.png") });
    const editor = await mp.navigateTo("/pages/report/report");
    await editor.waitFor(() => editor.data("ready"));
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
    await manager.waitFor(() => manager.data("ready"));
    assert.equal((await manager.data("reports")).length, 1);
    await mp.screenshot({ path: path.join(output, "manager.png") });
    const detail = await mp.navigateTo("/pages/detail/detail?id=UI-REPORT");
    await detail.waitFor(() => detail.data("report"));
    assert.equal((await detail.data("entries"))[0].feedback, "顾客体验良好");
    assert.equal((await detail.$$("textarea")).length, 0);
    await mp.screenshot({ path: path.join(output, "detail.png") });
    assert.deepEqual(exceptions, []);
    console.log(
      "UI 验证通过：四个页面编译、本人填写和保存、店长只读详情（模拟接口）",
    );
  } finally {
    await mp.restoreWxMethod("cloud.callFunction");
    await mp.restoreWxMethod("showModal");
    await mp.reLaunch("/pages/home/home");
    mp.disconnect();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
