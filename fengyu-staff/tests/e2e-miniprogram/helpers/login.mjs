// helpers/login.mjs — 通过 _testOpenid 在小程序运行时自动登录
//
// 前置条件（用户授权后由用户在 IDE 终端执行；本脚本不会主动改远端云函数配置）：
//   tcb fn config update staffApi  --envVars '..., ALLOW_TEST_OPENID=true'
//   tcb fn config update clientApi --envVars '..., ALLOW_TEST_OPENID=true'
//
// 若环境变量未开启，云函数中间件会忽略 _testOpenid，OPENID 走真实微信会话（开发者工具下可能为空），
// 多数 staffApi 接口会抛 UNAUTHORIZED；本 helper 不能"绕过"该校验。

import { TEST_OPENID_MANAGER, TEST_OPENID_CLIENT } from './constants.mjs';

/**
 * 在小程序运行时调用 staffApi.auth.login，使用 _testOpenid 模拟身份。
 *
 * @param {import('miniprogram-automator').MiniProgram} miniProgram
 * @param {string} testOpenid
 * @returns {Promise<any>} login 返回的 data（含 staffWfId / roles 等）
 */
export async function loginStaffWithTestOpenid(miniProgram, testOpenid = TEST_OPENID_MANAGER) {
  // miniProgram.evaluate 在小程序运行时上下文执行，可直接用 wx.cloud
  const result = await miniProgram.evaluate((openid) => {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'staffApi',
        data: {
          action: 'auth.login',
          payload: { _testOpenid: openid },
        },
        success: (res) => resolve(res.result),
        fail: (err) => reject(new Error(err && err.errMsg ? err.errMsg : String(err))),
      });
    });
  }, testOpenid);

  if (!result || result.code !== 0) {
    const msg = result?.message || JSON.stringify(result);
    throw new Error(
      `[L3 E2E] staffApi.auth.login 失败: ${msg}\n` +
      `  这通常意味着远端 staffApi 云函数未开启 ALLOW_TEST_OPENID 环境变量。\n` +
      `  授权后由用户执行：\n` +
      `    tcb fn config update staffApi --envVars 'ALLOW_TEST_OPENID=true,...其他变量'\n`,
    );
  }

  // 把 login 结果写入 globalData / storage，模拟前端 syncLogin 的副作用
  // 同时 hook wx.cloud.callFunction：让 page 内 callStaffApi 自动附 _testOpenid
  // （否则 page 调用 staffApi 走 IDE 真实 OPENID，requireManager 失败）
  await miniProgram.evaluate((loginData, openid) => {
    const app = getApp();
    if (app && typeof app.setStaffInfo === 'function') {
      app.setStaffInfo(loginData);
    } else if (app && app.globalData) {
      Object.assign(app.globalData, loginData);
    }
    try { wx.setStorageSync('_test_openid', openid); } catch (e) {}

    // 全局 hook：所有 wx.cloud.callFunction(staffApi) 自动注入 _testOpenid
    if (!wx.__e2e_callfn_hooked) {
      wx.__e2e_callfn_hooked = true;
      const orig = wx.cloud.callFunction.bind(wx.cloud);
      wx.cloud.callFunction = function (opts) {
        try {
          const testOpenid = wx.getStorageSync('_test_openid');
          if (testOpenid && opts?.name === 'staffApi' && opts.data?.payload) {
            if (opts.data.payload._testOpenid === undefined) {
              opts.data.payload = { ...opts.data.payload, _testOpenid: testOpenid };
            }
          } else if (testOpenid && opts?.name === 'staffApi' && opts.data && !opts.data.payload) {
            opts.data = { ...opts.data, payload: { _testOpenid: testOpenid } };
          }
        } catch (e) {}
        return orig(opts);
      };
    }
  }, result.data, testOpenid);

  return result.data;
}

/**
 * 顾客端登录（clientApi）。
 */
export async function loginClientWithTestOpenid(miniProgram, testOpenid = TEST_OPENID_CLIENT) {
  const result = await miniProgram.evaluate((openid) => {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'clientApi',
        data: {
          action: 'auth.login',
          payload: { _testOpenid: openid },
        },
        success: (res) => resolve(res.result),
        fail: (err) => reject(new Error(err && err.errMsg ? err.errMsg : String(err))),
      });
    });
  }, testOpenid);

  if (!result || result.code !== 0) {
    throw new Error(
      `[L3 E2E] clientApi.auth.login 失败: ${result?.message || JSON.stringify(result)}\n` +
      `  远端 clientApi 云函数需开启 ALLOW_TEST_OPENID=true`,
    );
  }
  return result.data;
}

/**
 * H3：切账号（不重启 IDE）。清空 storage + globalData，然后重走 login。
 *
 * ⚠️ 已知限制：auth.login 用 cloud.getWXContext().OPENID，不读 _testOpenid。
 *   所以 login 返回的 staffWfId/roles 还是 IDE 真实账号决定。
 *   loginAs 主要让后续 action（callStaffApiWithTestOpenid 带 _testOpenid）走对的 scope。
 *   断言"前端 globalData 身份"时需要谨慎 — staffWfId 字段不一定等于 newOpenid 对应的 employee_id。
 */
export async function loginAs(miniProgram, newOpenid) {
  await miniProgram.evaluate(() => {
    try { wx.removeStorageSync('_test_openid'); } catch (e) {}
    const app = getApp();
    if (app?.globalData) {
      // 保留 systemInfo / appId 等系统字段，清掉用户态字段
      const keep = { systemInfo: app.globalData.systemInfo, appId: app.globalData.appId };
      Object.keys(app.globalData).forEach(k => { delete app.globalData[k]; });
      Object.assign(app.globalData, keep);
    }
  });
  return loginStaffWithTestOpenid(miniProgram, newOpenid);
}

/**
 * 在小程序内直接调用任意 staffApi action，附带 _testOpenid。
 * 用于绕开页面 UI 直接驱动业务（如 order.confirmOffline）。
 */
export async function callStaffApiWithTestOpenid(miniProgram, action, payload = {}, testOpenid = TEST_OPENID_MANAGER) {
  const enriched = { ...payload, _testOpenid: testOpenid };
  const result = await miniProgram.evaluate((act, pl) => {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'staffApi',
        data: { action: act, payload: pl },
        success: (res) => resolve(res.result),
        fail: (err) => reject(new Error(err && err.errMsg ? err.errMsg : String(err))),
      });
    });
  }, action, enriched);

  if (!result || result.code !== 0) {
    throw new Error(`[L3 E2E] staffApi.${action} 失败: ${result?.message || JSON.stringify(result)}`);
  }
  return result.data;
}
