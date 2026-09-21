// capture-staff-guide.mjs — 补拍《员工端使用指南》缺失的截图占位
//
// 复用 L3 e2e 的 automator 基础设施，连接已运行的微信开发者工具（端口 9420，
// 已加载 fengyu-staff/miniprogram 项目），用 IDE 真实微信账号（= 测试员/南昌万科店，
// roles=admin+manager，与现有 14 张截图身份一致）登录后逐个补拍。
//
// 用法（前提：DevTools 已开 + 安全服务端口开启 + 在 staff 项目）：
//   cd fengyu-staff && bun tests/capture-staff-guide.mjs
//
// 仅补拍可自动化的静态/可 setData 复现的页面；以下需人工/团队提供，脚本会跳过并报告：
//   - 小程序码（团队提供的二维码图，非页面截图）
//   - 收款二维码/确认收款（需真实待支付订单）
//   - 4 步结算流程（多步交互，易碎，按需另补）

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchStaff, disconnect } from './e2e-miniprogram/helpers/automator.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '..', '..', 'docs', 'assets', '员工端')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = []; const skip = []

async function shoot(mp, name) {
  const file = path.join(OUT, `${name}.png`)
  await mp.screenshot({ path: file, fullPage: true })
  ok.push(name); console.log('OK    ', name)
}

const mp = await launchStaff()
try {
  // ---- 0) 登录页（initial）+ 选择视图（authed, 双身份）----
  // 先 reLaunch 回登录页（可能从已登录态返回），用 setData 复现两种 UI 状态。
  // 注意：登录页 onShow 会自检 session 并可能自动跳转，故 reLaunch 后立即 setData 抢渲染。
  try {
    // 登录页 onLoad 见 globalData.staffWfId 即跳转；先清掉它让登录页停在初始态（之后会重新登录）
    await mp.evaluate(() => { const a = getApp(); if (a?.globalData) a.globalData.staffWfId = '' })
    await mp.reLaunch('/pages/login/login')
    await sleep(900)
    const page = await mp.currentPage()
    if (page?.path === 'pages/login/login') {
      await page.setData({ checking: false, binding: false, errorMsg: '', phase: 'initial' })
      await sleep(600)
      await shoot(mp, '02-登录页')

      await page.setData({ checking: false, phase: 'authed', availableLoginLevels: ['store', 'management'], loginLevel: 'store' })
      await sleep(600)
      await shoot(mp, '03-选择视图')
    } else {
      skip.push(`02/03(reLaunch 后未停在登录页，当前=${page?.path})`)
      console.log('SKIP 02/03 — 当前页:', page?.path)
    }
  } catch (e) { skip.push(`02/03(${e.message.slice(0,40)})`); console.log('SKIP 02/03', e.message) }

  // ---- 登录（IDE 真实 openid → 测试员/manager），写 globalData 供后续页渲染 ----
  const login = await mp.evaluate(() => new Promise((res, rej) => {
    wx.cloud.callFunction({ // 单 env 内并存 staffApi(prod 库) 与 staffApiDev(dev 库)：写死会让断言库与被测页面写入库分裂
 name: (() => { try { const v = wx.getAccountInfoSync().miniProgram.envVersion; return v === 'release' || v === 'trial' ? 'staffApi' : 'staffApiDev' } catch (e) { return 'staffApiDev' } })(), data: { action: 'auth.login', payload: {} },
      success: (x) => res(x.result), fail: (e) => rej(new Error(e?.errMsg || String(e))) })
  }))
  if (!login || login.code !== 0) throw new Error('auth.login 失败: ' + (login?.message || JSON.stringify(login)))
  await mp.evaluate((data) => {
    const app = getApp()
    if (app && typeof app.setStaffInfo === 'function') app.setStaffInfo(data)
    else if (app?.globalData) Object.assign(app.globalData, data)
  }, login.data)
  console.log('LOGIN roles=', JSON.stringify(login.data?.roles))
  await sleep(800)

  // ---- 9) 顾客详情：进顾客 Tab → 取第一个顾客 id → 进详情 ----
  try {
    await mp.switchTab('/pages/customer-list/customer-list')
    await sleep(3000)
    const cid = await mp.evaluate(() => {
      const p = getCurrentPages().slice(-1)[0]
      const d = p?.data || {}
      // 在所有数组型字段里找第一个带 id/clientUserId 的顾客项（customers / results / ...）
      for (const k of Object.keys(d)) {
        const v = d[k]
        if (Array.isArray(v) && v.length && (v[0]?.id || v[0]?.clientUserId || v[0]?.userId)) {
          const c = v[0]
          return { from: k, id: c.id || c.userId || null, clientUserId: c.clientUserId || null }
        }
      }
      return { from: null, id: null, clientUserId: null }
    })
    console.log('  顾客来源字段:', cid?.from, 'id:', cid?.id || cid?.clientUserId)
    if (cid?.id || cid?.clientUserId) {
      const q = cid.id ? `id=${cid.id}` : `clientUserId=${cid.clientUserId}`
      await mp.navigateTo(`/packageCustomer/customer-detail/customer-detail?${q}`)
      await sleep(2500)
      await shoot(mp, '18-顾客详情')
    } else {
      skip.push('18-顾客详情(顾客列表为空，无可进详情的顾客)')
      console.log('SKIP 18 — 顾客列表空')
    }
  } catch (e) { skip.push(`18-顾客详情(${e.message.slice(0,40)})`); console.log('SKIP 18', e.message) }

  // ---- 8) 创建服务单：直接进 service-create 子包页 ----
  try {
    await mp.navigateTo('/packageService/service-create/service-create')
    await sleep(2000)
    const cur = await mp.currentPage()
    if (cur?.path?.includes('service-create')) {
      await shoot(mp, '17-创建服务单')
    } else {
      skip.push(`17-创建服务单(未进入页面，当前=${cur?.path})`)
      console.log('SKIP 17 — 当前页', cur?.path)
    }
  } catch (e) { skip.push(`17-创建服务单(${e.message.slice(0,40)})`); console.log('SKIP 17', e.message) }

} catch (e) {
  console.error('FATAL:', e.message)
} finally {
  console.log('\n=== captured:', ok.length, '===', ok.join(' | '))
  console.log('=== skipped :', skip.length, '===', skip.join(' | '))
  await disconnect(mp)
}
