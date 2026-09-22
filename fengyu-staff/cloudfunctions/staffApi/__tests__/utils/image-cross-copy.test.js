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

const CLIENT_DIR = '../../../../../fengyu-client/cloudfunctions/clientApi'

/** [staff 侧路径, client 侧路径] */
const COPIES = {
  'utils/image.js': [
    path.resolve(__dirname, '../../utils/image.js'),
    path.resolve(__dirname, `${CLIENT_DIR}/utils/image.js`),
  ],
  '__tests__/utils/image.test.js': [
    path.resolve(__dirname, 'image.test.js'),
    path.resolve(__dirname, `${CLIENT_DIR}/__tests__/utils/image.test.js`),
  ],
}

function read(p) {
  return fs.readFileSync(p, 'utf8')
}

// 下面几条只读 staff 那一份：上面的字节一致断言已保证两份逐位相同，
// 再对 client 份重跑一遍是纯重复（真出现分歧时，字节那条自己就是红的）。
const STAFF_IMAGE = COPIES['utils/image.js'][0]
const STAFF_SRC = read(STAFF_IMAGE)
const [HOST] = require(STAFF_IMAGE).COS_ALLOWED_HOSTS

describe('image 工具跨副本一致性守护', () => {
  test.each(Object.keys(COPIES))('%s：staffApi 与 clientApi 字节一致', (key) => {
    const [staffPath, clientPath] = COPIES[key]
    // `readFileSync` 透明跟随 symlink —— 有人用软链"保持两端同步"的话字节断言恒绿，
    // 而软链恰恰是根 CLAUDE.md 明令禁止的跨端共享手段（用户已 veto）。
    //
    // 断言的是「**两端解析到两个不同的真实文件**」，而不是
    // `lstatSync(p).isSymbolicLink() === false`（只看文件本身，软链整个 `utils/`
    // 目录会漏）或 `realpathSync(p) === path.resolve(p)`（仓库本身位于软链路径下时
    // ——`/tmp` → `/private/tmp`、把工作区放在软链目录里——会误红）。
    // realpath 解开路径上每一段软链，所以无论链在文件还是任一层目录，
    // 共享同一份内容时两边会塌成同一个真实路径。
    expect(fs.realpathSync(staffPath)).not.toBe(fs.realpathSync(clientPath))
    expect(read(staffPath)).toBe(read(clientPath))
  })

  /**
   * 字节一致断言在两端"同时被改坏成同一个样子"时不会转红。
   * 下面几条锁死最容易被"顺手简化"掉的形态，是独立于字节比对的第二道闸门。
   */
  test('box 与面积两种模式都在，且共用同一套准入规则', () => {
    // ⚠️ 必须 require 真模块查 `typeof`，不能对源码做 `toContain('safeThumbUrl')`——
    // 这几个名字在**注释里**就出现多次（`{@link safeThumbUrlByArea}` 等），
    // 把函数定义改名后源码断言照样绿，是个恒真守护。
    // 而且 `safeThumbUrl` 是 `safeThumbUrlByArea` 的子串，前者被后者蕴含。
    const mod = require(STAFF_IMAGE)
    expect(typeof mod.safeThumbUrl).toBe('function')
    expect(typeof mod.safeThumbUrlByArea).toBe('function')

    // 喂同一组非法输入，两种模式要给出一致的拒绝。
    // 这比 `toContain('parseProcessableUrl')` 强——它验的是行为不是字面量。
    //
    // ⚠️ 这组构造要覆盖的不只是"现在会不会被拒"，更是**比较方式被顺手简化**之后
    // 会不会被拒。字面量守护只锁得住白名单数组的**内容形状**，锁不住
    // `includes` 有没有被改成 `startsWith` / `endsWith`（"将来要加 CDN 子域" 之类理由）。
    for (const bad of [
      null, '', 'ftp://evil.com/a.jpg',
      'https://img.example.com/dir/a.png',              // 非 COS 域名
      'https://a.tcb.qcloud.la@evil.com/dir/a.png',     // userinfo 伪装
      `https://${HOST}/dir/a.svg`,                      // 非图片扩展名
      `https://${HOST}/dir/a.png?q-signature=d`,        // 带 COS 签名
      'https://9999-other-env-1406056527.tcb.qcloud.la/dir/a.png', // 同后缀但不在白名单

      // —— host 比较方式退化时会被放行的两类（GLM 评审给出）——
      `https://evil.${HOST}/dir/a.png`,   // 白名单项的**子域**：endsWith('.'+h) 会命中
      `https://${HOST}.evil.com/dir/a.png`, // 白名单项作**前缀**：startsWith(h) 会命中

      // —— pathname 白名单被放宽时会被放行的三类（GLM 评审给出）——
      // 图片样式可直接挂在对象键后且能携带完整缩放规则，与 imageMogr2 并存时
      // 优先级 COS 未定义 → 等于重开「URL 看着有规则、实际原图直送」的通道
      `https://${HOST}/dir/sub/a.png`,     // 三段对象键
      `https://${HOST}/dir/a.png!style`,   // 默认分隔符的样式
      `https://${HOST}/dir/a.png%21style`, // 编码形态的样式（pathname 不解码）
    ]) {
      expect(mod.safeThumbUrl(bad, 400)).toBeNull()
      expect(mod.safeThumbUrlByArea(bad, 2250000)).toBeNull()
    }
  })

  test('host 白名单与两条缩略规则的字面量都没被改写', () => {
    // 断言的是**代码字面量**，不是"全文不出现某字符串"——
    // 本模块注释里就写着 `tcloudbaseapp.com` / `thumbnail/!<Area>@`
    // （在解释为什么刻意不放通它们），全文 not.toContain 会误红。

    // host 白名单必须是**精确 bucket 列表**，不能退回后缀通配（#232 评审）：
    // 数据万象按 bucket 绑定，同后缀但没开通的环境会原样返回原图 = 保护静默失效。
    const mod = require(STAFF_IMAGE)
    expect(Array.isArray(mod.COS_ALLOWED_HOSTS)).toBe(true)
    expect(mod.COS_ALLOWED_HOSTS.length).toBeGreaterThan(0)
    for (const h of mod.COS_ALLOWED_HOSTS) {
      // 每一项都必须是完整 hostname，不能是 `.tcb.qcloud.la` 这种后缀片段，
      // 也不能含通配符——那等于把精确白名单偷偷改回通配
      expect(h).toMatch(/^[\w-]+\.tcb\.qcloud\.la$/)
    }
    // 源码里不得再出现后缀通配正则（防止有人加回一条 `endsWith` 式的兜底）
    expect(STAFF_SRC).not.toMatch(/\/\\\.tcb\\\.qcloud\\\.la\$\//)

    // 两条规则的拼法逐字锁定：
    // - box 必须双边（只限宽的 `${n}x` 高度无界）
    // - 面积必须不带 `!`（`!<Area>@` 实测在本项目 bucket 上原样返回原图）
    expect(STAFF_SRC).toContain('`?imageMogr2/thumbnail/${boxSize}x${boxSize}`')
    expect(STAFF_SRC).toContain('`?imageMogr2/thumbnail/${maxPixels}@`')
  })

  test('档位上界真的会拒绝越界值（不只是写了常量）', () => {
    // 这三道防线（#232）此前只有注释没有断言。
    // box 是 contain 语义、不放大，N 取得过大等于完全不约束 —— 属「规则看着在、实际不生效」。
    const mod = require(STAFF_IMAGE)

    // ⚠️ 钉**绝对值**，不是 `mod.MAX_THUMB_BOX + 1` 这种相对自身的边界 ——
    // 后者在有人把上界改成 99999 时照样绿（GLM 评审指出）。
    // 这两个数还必须与前端净化器 cart.ts 的 SANITIZE_MAX_EDGE / SANITIZE_MAX_AREA
    // 相同，否则落在缝隙里的档位会被云函数下发、被前端静默置占位。
    expect(mod.MAX_THUMB_BOX).toBe(2000)
    expect(mod.MAX_THUMB_PIXELS).toBe(4000000)

    const url = `https://${mod.COS_ALLOWED_HOSTS[0]}/product-covers/a.png`
    expect(mod.safeThumbUrl(url, mod.MAX_THUMB_BOX)).toContain('imageMogr2/thumbnail/')
    expect(mod.safeThumbUrl(url, mod.MAX_THUMB_BOX + 1)).toBeNull()
    expect(mod.safeThumbUrlByArea(url, mod.MAX_THUMB_PIXELS)).toContain('imageMogr2/thumbnail/')
    expect(mod.safeThumbUrlByArea(url, mod.MAX_THUMB_PIXELS + 1)).toBeNull()
    // 超长 URL：cover_image 是无约束 text，10MB 的值会撑爆整个列表接口响应体
    const tooLong = `https://${HOST}/product-covers/${'a'.repeat(mod.MAX_SOURCE_URL_LENGTH)}.png`
    expect(mod.safeThumbUrl(tooLong, 400)).toBeNull()
    // userinfo 不得随 toString() 带出去
    expect(mod.safeThumbUrl(`https://u:p@${HOST}/product-covers/a.png`, 400))
      .toBe(`https://${HOST}/product-covers/a.png?imageMogr2/thumbnail/400x400`)
  })

  /**
   * meta-guard：守护本身必须跑在 CI 里，否则它只在本地存在，拦不住回归合入。
   *
   * 仿 `db-script-tests.yml` 的「CI workflow 的 paths 覆盖所有内联副本」反向断言
   * （由 `db/scripts/__tests__/db-target-guard.test.js` 锁住）。
   *
   * ⚠️ 这里断言的是**性质**（不准写手工清单），不是「本文件名出现在 lint.yml 里」。
   * 守文件名等于把「手工维护清单」这个错误形状写进守护：以后每加一个守护都要改两处，
   * 而漏改的那一次正好就是守护失效的那一次 ——
   * `clientApi/__tests__/utils/lakala-cross-copy.test.js` 就是这么掉进洞里的
   * （字节一致守护写得好好的，从未在任何 CI job 里跑过）。
   * 守住「跑全量」，谁都不会被漏掉。
   */
  test('meta：CI 跑的是 staffApi 全量 vitest，不是手工文件清单', () => {
    const lintYml = path.resolve(__dirname, '../../../../../.github/workflows/lint.yml')
    const yml = read(lintYml)

    // ⚠️ 断言命令**恰好**是不带任何参数的 `npx vitest run`，而不是用负向正则
    // 去猜"手工清单长什么样"。负向匹配挡不住 `--dir __tests__/utils`、
    // `-t <pattern>`、`--project` 这些同样会缩小范围的写法。
    const staffVitestRuns = [...yml.matchAll(
      /working-directory: fengyu-staff\/cloudfunctions\/staffApi\n\s*run: (.+)$/gm
    )]
      .map((m) => m[1].trim())
      // 同一个 job 里还有 `npm ci || npm install` 之类的步骤，只看跑测试那条
      .filter((cmd) => cmd.includes('vitest'))

    expect(staffVitestRuns).toEqual(['npx vitest run'])

    // paths 必须覆盖守护实际读到的**全部**文件，否则「改了但不触发」等于没有守护：
    // - 两端 cloudfunctions（字节一致比对读两端的 utils/image.js 与 image.test.js）
    // - bundle-picker 组件（image-staff-bundle.test.js 读它的 wxml 断言 lazy-load/binderror）
    // - client miniprogram（cart.test.ts 的闭环守护比对第三份副本的白名单与上界）
    expect(yml).toContain("- 'fengyu-staff/cloudfunctions/**/*.js'")
    expect(yml).toContain("- 'fengyu-client/cloudfunctions/**/*.js'")
    expect(yml).toContain("- 'fengyu-staff/miniprogram/components/bundle-picker/**'")
    expect(yml).toContain("- 'fengyu-client/miniprogram/**'")

    // 第三份副本的守护必须真有 job 跑，不能只有触发路径
    // （光有 paths 没有 job = 触发了却不跑，比不触发更有欺骗性）
    expect(yml).toMatch(
      /working-directory: fengyu-client\/miniprogram\n\s*run: npx vitest run/
    )
  })
})
