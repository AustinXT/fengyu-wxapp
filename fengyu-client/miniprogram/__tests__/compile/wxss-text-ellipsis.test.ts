/**
 * WXSS 文本截断有效性守护（#238）
 *
 * 微信小程序的 `<text>` 默认 `display: inline`，而 **inline 元素上 `text-overflow: ellipsis`
 * 完全不生效**（flex / min-width / max-width 同样不生效）。结果是：样式里写了截断，
 * 真机上长文本要么整行撑出屏幕、要么被硬裁切，没有「…」。
 *
 * 这类缺陷**不会被任何现有测试抓到**（wxss 不参与编译检查、单测不渲染样式），
 * 也不会在短文本下暴露，只在真机 + 长数据时出现 —— #184 就是这么被发现的，
 * 随后全仓扫描又找出十几处同型。本测试把这条规则钉死，防止再次扩散。
 *
 * 判据：某个 class 声明了 `text-overflow`，且该 class 在同目录 wxml 里挂在 `<text>` 上
 *      → 它必须同时声明 `display`（`block` / `-webkit-box` / `flex` 等均可）。
 * 挂在 `<view>` 上的不受影响（块级元素天然生效）。
 *
 * ⚠️ 判据是**显式化要求**，不等于「每条命中都是真 bug」：
 * CSS 规范（Display Module L3 §2.7 Automatic Box Type Transformations）规定
 * **flex container 的直接子元素其 display 会被 blockify**（inline → block）。
 * 本仓多数命中处的父容器恰好是 flex，理论上它们本就已是 block、ellipsis 本就生效。
 * 但这条依赖「父容器保持 flex」这个易被后续改动破坏的隐式前提 —— 父容器一旦从
 * flex 改成 block，截断会**静默失效**且没有任何报错。所以这里坚持要求显式声明，
 * 宁可多写一行也不依赖隐式转换。
 *
 * 这份文件与 staff 端的同名测试是**各端独立副本**（CLAUDE.md：禁止跨端共享代码目录）。
 */
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')

interface Rule {
  file: string
  line: number
  selector: string
  className: string | null
  hasDisplay: boolean
}

function walk(dir: string, ext: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'miniprogram_npm') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, ext, acc)
    else if (entry.name.endsWith(ext)) acc.push(full)
  }
  return acc
}

/** 取出所有声明了 text-overflow 的规则块 */
function parseEllipsisRules(file: string): Rule[] {
  const src = fs.readFileSync(file, 'utf-8')
  const rules: Rule[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const [, rawSel, body] = m
    if (!/text-overflow/.test(body)) continue
    const selector = rawSel.trim().replace(/\s+/g, ' ')
    const classes = selector.match(/\.([A-Za-z0-9_-]+)/g)
    rules.push({
      file,
      line: src.slice(0, m.index).split('\n').length,
      selector,
      // 取选择器末尾的 class —— 它才是实际挂在元素上的那个
      className: classes ? classes[classes.length - 1].slice(1) : null,
      hasDisplay: /(^|\n|;)\s*display\s*:/.test(body) || /-webkit-box/.test(body),
    })
  }
  return rules
}

/** 该 class 在同目录 wxml 里被挂在哪些标签上 */
function hostTags(dir: string, className: string): Set<string> {
  const tags = new Set<string>()
  for (const wxml of fs.readdirSync(dir).filter((f) => f.endsWith('.wxml'))) {
    const src = fs.readFileSync(path.join(dir, wxml), 'utf-8')
    const re = /<(\w[\w-]*)\b[^>]*class="([^"]*)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const [, tag, classAttr] = m
      // 边界匹配，避免 `.store-name` 命中 `store-name-row`
      if (new RegExp(`(^|[\\s{}'"])${className}($|[\\s{}'"])`).test(classAttr)) tags.add(tag)
    }
  }
  return tags
}

describe('WXSS 文本截断有效性（#238）', () => {
  const wxssFiles = walk(ROOT, '.wxss')

  test(`<text> 上的 text-overflow 必须配 display（扫描 ${wxssFiles.length} 个 wxss）`, () => {
    const broken: string[] = []

    for (const file of wxssFiles) {
      for (const rule of parseEllipsisRules(file)) {
        if (rule.hasDisplay || !rule.className) continue
        if (!hostTags(path.dirname(file), rule.className).has('text')) continue
        broken.push(
          `${path.relative(ROOT, file)}:${rule.line}  .${rule.className}` +
            ' —— 挂在 <text> 上但缺 display，ellipsis 不会生效',
        )
      }
    }

    expect(
      broken,
      `\n以下 class 的文本截断在真机上是失效的（<text> 默认 display:inline）：\n` +
        broken.map((b) => `  · ${b}`).join('\n') +
        `\n\n修法：给该 class 补 \`display: block;\`（多行截断用 \`-webkit-box\`）。\n` +
        `⚠️ 若该 class 已写了 flex / min-width / max-width，补 display 后这些约束**才会开始生效**，\n` +
        `   改完必须在开发者工具里确认布局没有反而被挤压。\n`,
    ).toEqual([])
  })

  test('对照组：已正确实现的写法不被误报', () => {
    // home 的 .sidebar-item-text 是本端已带 display: block 的正例
    const file = path.join(ROOT, 'pages/home/home.wxss')
    const rule = parseEllipsisRules(file).find((r) => r.className === 'sidebar-item-text')
    expect(rule, 'sidebar-item-text 规则应存在（对照组失效说明扫描器坏了）').toBeTruthy()
    expect(rule!.hasDisplay).toBe(true)

    // pagesExperience/list 的 .card-title 用 -webkit-box 做多行截断，也应被认作已处理
    const boxFile = path.join(ROOT, 'pagesExperience/list/list.wxss')
    const boxRule = parseEllipsisRules(boxFile).find((r) => r.className === 'card-title')
    expect(boxRule, 'card-title 规则应存在').toBeTruthy()
    expect(boxRule!.hasDisplay).toBe(true)
  })

  test('扫描器自检：能识别出 <text> 宿主与缺失的 display', () => {
    // 防「扫描器恒返回空集 → 测试恒绿」这类假绿
    const totalRules = wxssFiles.reduce((n, f) => n + parseEllipsisRules(f).length, 0)
    expect(totalRules, '全仓应扫到若干 text-overflow 规则，为 0 说明解析器坏了').toBeGreaterThan(5)

    const withText = wxssFiles.some((f) =>
      parseEllipsisRules(f).some(
        (r) => r.className && hostTags(path.dirname(f), r.className).has('text'),
      ),
    )
    expect(withText, '应至少有一个 text-overflow class 挂在 <text> 上（否则宿主识别坏了）').toBe(true)
  })
})
