// helpers/toast.mjs — wx.showToast 监听 + 断言（H2）
//
// wx.showToast 不是 DOM 节点，automator 拿不到 toast 文案。
// 用 evaluate 把 wx.showToast 钩成全局推一份 title 到 wx.__e2e_toasts 数组。
// 测试断言时 poll 该数组。
//
// 必须在 launch + login 之后立即调一次 installToastHook(miniProgram)
// 以后整个 session 内 toast 都会被记录。

export async function installToastHook(miniProgram) {
  await miniProgram.evaluate(() => {
    if (wx.__e2e_toasts_installed) return;
    wx.__e2e_toasts = [];
    wx.__e2e_toasts_installed = true;
    const orig = wx.showToast;
    wx.showToast = function (opts) {
      try {
        wx.__e2e_toasts.push({
          title: opts?.title || '',
          icon: opts?.icon || 'none',
          ts: Date.now(),
        });
      } catch (e) {}
      return orig.call(this, opts);
    };
    // 类似 hook showModal（确认弹层用）
    const origModal = wx.showModal;
    wx.__e2e_modals = [];
    wx.showModal = function (opts) {
      try {
        wx.__e2e_modals.push({
          title: opts?.title || '',
          content: opts?.content || '',
          ts: Date.now(),
        });
      } catch (e) {}
      return origModal.call(this, opts);
    };
  });
}

/**
 * 等待并断言出现含 expectedText 的 toast（poll 模式）。
 * 默认 3s 超时。返回匹配的 toast 对象。
 */
export async function assertToast(miniProgram, expectedText, { timeoutMs = 3000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const toasts = await miniProgram.evaluate(() => wx.__e2e_toasts || []);
    const hit = toasts.find(t => (t.title || '').includes(expectedText));
    if (hit) return hit;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  // 失败时打出所有捕获的 toast 便于排查
  const allToasts = await miniProgram.evaluate(() => wx.__e2e_toasts || []);
  throw new Error(
    `[L3 E2E] assertToast 超时 ${timeoutMs}ms: 期望含 "${expectedText}"，` +
    `实际捕获 ${allToasts.length} 条：${JSON.stringify(allToasts.map(t => t.title))}`
  );
}

/**
 * 清空 toast 缓存（每个 step 之间调用，避免上一步的 toast 干扰当前 step 的断言）。
 */
export async function clearToasts(miniProgram) {
  await miniProgram.evaluate(() => { wx.__e2e_toasts = []; wx.__e2e_modals = []; });
}

/**
 * 模拟用户点击 modal 的"确定"按钮（自动通过确认弹层）。
 * 必须在 navigate / tap 引发 modal 弹出之前调用以提前 hook。
 */
export async function autoConfirmModal(miniProgram, { confirm = true } = {}) {
  await miniProgram.evaluate((shouldConfirm) => {
    const origModal = wx.showModal;
    wx.showModal = function (opts) {
      // 直接 resolve confirm，不真正弹窗
      const result = { confirm: shouldConfirm, cancel: !shouldConfirm, errMsg: 'showModal:ok' };
      if (opts?.success) opts.success(result);
      if (opts?.complete) opts.complete(result);
      return Promise.resolve(result);
    };
  }, confirm);
}
