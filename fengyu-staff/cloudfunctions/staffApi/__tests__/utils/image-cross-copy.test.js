/**
 * image 工具跨副本一致性守护（issue #232）
 *
 * 项目规范：禁止跨端共享代码目录，各端保留独立副本，一致性靠测试守护
 * （详见根 CLAUDE.md「禁止跨端共享代码目录」）。本文件沿用
 * `clientApi/__tests__/utils/lakala-cross-copy.test.js` 的字节一致模式：
 *
 *   ├── fengyu-client/cloudfunctions/clientApi/utils/image.js
 *   └── fengyu-staff/cloudfunctions/staffApi/utils/image.js
 *
 * 为什么是**字节一致**而不是「函数行为一致」：
 * 这个模块里的每一条校验都是 issue #230 五轮双谱系评审逐个堵出来的绕过构造
 * （指令大小写、userinfo 注入、反斜杠 authority、样式分隔符、签名参数自声明……）。
 * 行为断言只能覆盖你想到的构造，字节比对覆盖所有你没想到的。
 * 两端各自用不到的展示档位常量一并带着，是刻意的取舍——
 * **安全逻辑漂移是漏洞，多几个未使用的常量是无害的**。
 */
const fs = require('fs')
const path = require('path')

const STAFF_IMAGE = path.resolve(__dirname, '../../utils/image.js')
const CLIENT_IMAGE = path.resolve(
  __dirname,
  '../../../../../fengyu-client/cloudfunctions/clientApi/utils/image.js',
)

function read(p) {
  return fs.readFileSync(p, 'utf8')
}

describe('image 工具跨副本一致性守护', () => {
  test('image.js：staffApi 与 clientApi 字节一致', () => {
    expect(read(STAFF_IMAGE)).toBe(read(CLIENT_IMAGE))
  })

  /**
   * 字节一致断言在两端"同时被改坏成同一个样子"时不会转红。
   * 下面几条锁死最容易被"顺手简化"掉的形态，是独立于字节比对的第二道闸门。
   */
  test('两端都保留 box 与面积两种模式的导出', () => {
    for (const p of [STAFF_IMAGE, CLIENT_IMAGE]) {
      const src = read(p)
      expect(src).toContain('safeThumbUrl')
      expect(src).toContain('safeThumbUrlByArea')
      // 两种模式共用同一个准入校验，防止"给其中一个加规则"造成分叉
      expect(src).toContain('parseProcessableUrl')
    }
  })

  test('两端的 host 白名单与缩略规则字面量都没被改写', () => {
    // 断言的是**代码字面量**，不是"全文不出现某字符串"——
    // 本模块注释里就写着 `tcloudbaseapp.com` / `thumbnail/!<Area>@`
    // （在解释为什么刻意不放通它们），全文 not.toContain 会误红。
    for (const p of [STAFF_IMAGE, CLIENT_IMAGE]) {
      const src = read(p)

      // host 白名单只认 CloudBase 云存储域名；放通静态托管 / 通用 COS 都会让保护静默失效
      const hostPattern = src.match(/^const COS_HOST_PATTERN = (.+)$/m)
      expect(hostPattern).not.toBeNull()
      expect(hostPattern[1].trim()).toBe('/\\.tcb\\.qcloud\\.la$/i')

      // 两条规则的拼法逐字锁定：
      // - box 必须双边（只限宽的 `${n}x` 高度无界）
      // - 面积必须不带 `!`（`!<Area>@` 实测在本项目 bucket 上原样返回原图）
      expect(src).toContain('`?imageMogr2/thumbnail/${boxSize}x${boxSize}`')
      expect(src).toContain('`?imageMogr2/thumbnail/${maxPixels}@`')
    }
  })
})
