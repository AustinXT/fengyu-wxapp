/**
 * 拉卡拉工具跨副本一致性守护
 *
 * 项目规范：禁止跨端共享代码目录，clientApi / payNotify / admin 各保留独立 lakala 副本，
 * 一致性靠测试守护（详见根 CLAUDE.md「禁止跨端共享代码目录」）。
 *
 * 守护两件事：
 *  1. clientApi 与 payNotify 的 lakala-sign.js / lakala-config.js **字节一致**（签名算法 + PEM 归一化不漂移）。
 *  2. 三端（clientApi / payNotify / admin）的配置读取都含 `normalizePem`（PEM \n 归一化），
 *     防止有人删掉它导致 `DECODER routines::unsupported` 加签/验签全挂的回归（联调根因）。
 */
const fs = require('fs')
const path = require('path')

const CLIENT = path.resolve(__dirname, '../../utils')
const PAYNOTIFY = path.resolve(__dirname, '../../../payNotify/utils')
const ADMIN_LAKALA_CLIENT = path.resolve(
  __dirname,
  '../../../../../fengyu-admin/src/lib/lakala-client.ts',
)

function read(p) {
  return fs.readFileSync(p, 'utf8')
}

describe('lakala 跨副本一致性守护', () => {
  test('lakala-sign.js：clientApi 与 payNotify 字节一致', () => {
    expect(read(path.join(CLIENT, 'lakala-sign.js'))).toBe(
      read(path.join(PAYNOTIFY, 'lakala-sign.js')),
    )
  })

  test('lakala-config.js：clientApi 与 payNotify 字节一致', () => {
    expect(read(path.join(CLIENT, 'lakala-config.js'))).toBe(
      read(path.join(PAYNOTIFY, 'lakala-config.js')),
    )
  })

  test('三端配置读取都含 PEM \\n 归一化（normalizePem），防 DECODER unsupported 回归', () => {
    expect(read(path.join(CLIENT, 'lakala-config.js'))).toContain('normalizePem')
    expect(read(path.join(PAYNOTIFY, 'lakala-config.js'))).toContain('normalizePem')
    expect(read(ADMIN_LAKALA_CLIENT)).toContain('normalizePem')
  })
})
