/**
 * WXSS 文本截断有效性守护（#238）
 *
 * `text-overflow: ellipsis` 只在元素是 **block container** 时生效。两种常见写法会让它静默失效：
 *
 *   ① 挂在 `<text>` 上且未声明 `display` —— 小程序 `<text>` 默认 `display: inline`，
 *      inline 元素上 ellipsis（以及 flex / min-width / max-width）全都不生效。
 *   ② 声明了 `display: flex` / `inline-flex` / `grid` —— flex/grid container **不是**
 *      block container，写在它上面的 ellipsis 同样不生效；文字会被 `overflow: hidden`
 *      硬裁切、没有「…」。这一类比 ① 更隐蔽，因为"写了 display"看上去像是已经处理过了。
 *
 * 两类都不会被任何其它测试抓到（wxss 不参与编译检查、单测不渲染样式），
 * 也不会在短文本下暴露，只在真机 + 长数据时出现。本测试把规则钉死。
 *
 * ⚠️ 关于 ① 的一个重要事实：CSS Display L3 §2.7 规定 **flex container 的流内直接子元素
 * 其 display 会被 blockify**（inline → block）。本仓多数 `<text>` 的父容器恰好是 flex，
 * 所以它们**本来就已经是 block**、ellipsis 本来就生效。
 * 仍然坚持要求显式声明，是因为 blockify 依赖「父容器保持 flex」这个隐式前提 ——
 * 父容器哪天从 flex 改成 block，截断会静默失效且没有任何报错。
 * （② 则是真正会当场失效的缺陷，与 blockify 无关。）
 *
 * 这份文件与 staff 端的同名测试是**各端独立副本**（CLAUDE.md：禁止跨端共享代码目录）。
 */
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')

/** 能让 text-overflow 生效的 display 值（block container 或其等价物） */
const BLOCK_CONTAINER = [
  'block',
  'inline-block',
  'flow-root',
  'list-item',
  'table-cell',
  '-webkit-box', // 多行截断的标准写法
]
/** 明确不是 block container —— 写了也白写 */
const NOT_BLOCK_CONTAINER = ['flex', 'inline-flex', 'grid', 'inline-grid', 'contents', 'none']

/**
 * 已确认失效、但不在 #238 授权范围内的豁免项（格式：`相对路径|class`）。
 *
 * ⚠️ 本清单是**自检**的：下面有一条测试断言「清单里的每一项今天仍然命中」，
 * 所以一旦某项被修好或文件被删，测试会变红提醒你回来清理清单，不会静默腐烂。
 */
const KNOWN_BROKEN: string[] = [
  // client 端当前无此类失效项（staff 端有 4 处 `.card-filter-picker`，见该端同名测试）。
  // 保留这个空数组与配套的「清单不得腐烂」自检，使两端结构一致。
]

interface Rule {
  file: string
  line: number
  classNames: string[]
  display: string | null
  hasLineClamp: boolean
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

/** 剥掉 CSS 注释 —— 否则 body 里一句 `/* display: block *​/` 就能骗过判据 */
function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/** 取出所有声明了 text-overflow 或 -webkit-line-clamp 的规则块 */
export function parseTruncationRules(rawSrc: string, file = '<inline>'): Rule[] {
  const src = stripCssComments(rawSrc)
  const rules: Rule[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const [, rawSel, body] = m
    const hasEllipsis = /text-overflow\s*:\s*ellipsis/.test(body)
    const hasLineClamp = /-webkit-line-clamp/.test(body)
    if (!hasEllipsis && !hasLineClamp) continue
    // 同一块里可能有多个 display（后者覆盖前者，如 `display:block` 后跟 `display:-webkit-box`），
    // 判据必须取**最后一个** —— 取第一个会把实际生效的 -webkit-box 误判成 block
    const ds = [...body.matchAll(/(?:^|\n|;)\s*display\s*:\s*([^;]+)/g)]
    rules.push({
      file,
      line: src.slice(0, m.index).split('\n').length,
      // 分组选择器（`.a, .b { … }`）要取**全部** class，只取最后一个会漏
      classNames: [...new Set((rawSel.match(/\.([A-Za-z0-9_-]+)/g) || []).map((c) => c.slice(1)))],
      display: ds.length ? ds[ds.length - 1][1].trim() : null,
      hasLineClamp,
    })
  }
  return rules
}

/**
 * 某个 class 在哪些标签上被使用。
 * 全局样式（app.wxss）的 class 可能用在任意页面，所以扫**全端** wxml；
 * 页面/组件样式只扫同目录（小程序的组件样式是隔离的）。
 */
function hostTags(wxmlFiles: string[], className: string): Set<string> {
  const tags = new Set<string>()
  // 属性值里可能出现 `>`（`wx:if="{{a > b}}"`），所以先整体吃掉带引号的属性值，
  // 不能用 `[^>]*` —— 那会在第一个 `>` 处提前断开，漏掉后面的 class=""
  const re = /<([\w-]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  const bound = (cls: string) => new RegExp(`(^|[\\s{}'"])${cls}($|[\\s{}'"])`)
  for (const wxml of wxmlFiles) {
    const src = fs.readFileSync(wxml, 'utf-8')
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const [, tag, attrs] = m
      const cm = /class="([^"]*)"/.exec(attrs)
      if (cm && bound(className).test(cm[1])) tags.add(tag)
    }
  }
  return tags
}

describe('WXSS 文本截断有效性（#238）', () => {
  const wxssFiles = walk(ROOT, '.wxss')
  const allWxml = walk(ROOT, '.wxml')

  /** 扫全端，返回 [未豁免的失效项, 命中豁免清单的项] */
  function scanBroken(): [string[], string[]] {
    const broken: string[] = []
    const exempted: string[] = []

    for (const file of wxssFiles) {
      const isGlobal = path.dirname(file) === ROOT // app.wxss 等全局样式
      const scopeWxml = isGlobal
        ? allWxml
        : allWxml.filter((w) => path.dirname(w) === path.dirname(file))
      const rel = path.relative(ROOT, file)

      for (const rule of parseTruncationRules(fs.readFileSync(file, 'utf-8'), file)) {
        for (const cls of rule.classNames) {
          const d = rule.display

          // ② display 写了但不是 block container —— 无论挂在什么标签上都失效
          if (d && NOT_BLOCK_CONTAINER.some((v) => d === v || d.startsWith(v))) {
            const tags = hostTags(scopeWxml, cls)
            if (tags.size === 0) continue // class 未被使用（死样式），不报
            const msg =
              `${rel}:${rule.line}  .${cls}  display:${d}` +
              ` —— flex/grid container 不是 block container，ellipsis 不生效（宿主 <${[...tags].join('/')}>）`
            ;(KNOWN_BROKEN.includes(`${rel}|${cls}`) ? exempted : broken).push(msg)
            continue
          }

          // 多行截断必须配 -webkit-box
          if (rule.hasLineClamp && !(d && d.includes('-webkit-box'))) {
            broken.push(
              `${rel}:${rule.line}  .${cls}` +
                ' —— 用了 -webkit-line-clamp 但 display 不是 -webkit-box，多行截断不生效',
            )
            continue
          }

          // ① 没写 display 且挂在 <text> 上 —— inline 不生效
          if (!d && hostTags(scopeWxml, cls).has('text')) {
            broken.push(
              `${rel}:${rule.line}  .${cls}` +
                ' —— 挂在 <text> 上但缺 display，<text> 默认 inline，ellipsis 不生效',
            )
          }
        }
      }
    }

    return [broken, exempted]
  }

  test(`截断样式必须写在 block container 上（扫描 ${wxssFiles.length} 个 wxss）`, () => {
    const [broken] = scanBroken()
    expect(
      broken,
      `\n以下截断样式在真机上是失效的：\n` +
        broken.map((b) => `  · ${b}`).join('\n') +
        `\n\n修法：\n` +
        `  · 挂在 <text> 上缺 display → 补 \`display: block;\`\n` +
        `  · display 是 flex/grid → 截断要挪到**承载文字的子元素**上（子元素记得加 min-width: 0），\n` +
        `    或把该元素改成 block container（若它本来只是为了垂直居中，可用 line-height 替代）\n` +
        `  · -webkit-line-clamp → 必须配 \`display: -webkit-box; -webkit-box-orient: vertical;\`\n`,
    ).toEqual([])
  })

  // 豁免清单必须保持"活"的 —— 项目被修好 / 文件被删 / class 改名时立刻变红，
  // 防止清单里堆着一堆早已不存在的条目，把真实新增的失效项也一起遮住。
  test('豁免清单每一项今天仍然命中（清单不得腐烂）', () => {
    const [, exempted] = scanBroken()
    const hit = new Set(
      exempted.map((e) => {
        const [loc, rest] = e.split('  .')
        return `${loc.split(':')[0]}|${rest.split(' ')[0]}`
      }),
    )
    const stale = KNOWN_BROKEN.filter((k) => !hit.has(k))
    expect(
      stale,
      `\n豁免清单里的这些项已不再命中（可能已被修好或文件已变动），请从 KNOWN_BROKEN 中删除：\n` +
        stale.map((s) => `  · ${s}`).join('\n') + '\n',
    ).toEqual([])
  })

  test('对照组：已正确实现的写法不被误报', () => {
    // 本端已带 display: block 的正例
    const file = path.join(ROOT, 'pages/home/home.wxss')
    const rule = parseTruncationRules(fs.readFileSync(file, 'utf-8')).find((r) =>
      r.classNames.includes('sidebar-item-text'),
    )
    expect(rule, 'sidebar-item-text 规则应存在（对照组失效说明扫描器坏了）').toBeTruthy()
    expect(rule!.display).toBe('block')

    // -webkit-box 多行截断的正例也不得误报
    const boxFile = path.join(ROOT, 'pagesExperience/list/list.wxss')
    const boxRule = parseTruncationRules(fs.readFileSync(boxFile, 'utf-8')).find((r) =>
      r.classNames.includes('card-title'),
    )
    expect(boxRule!.display).toBe('-webkit-box')
  })

  // 防「解析器退化 → 恒返回空集/恒 true → 测试恒绿」这类假绿。
  // 用内联 fixture 直喂解析器，不依赖仓库现状。
  describe('解析器自检（fixture 驱动，防假绿）', () => {
    test('能识别出缺失的 display', () => {
      const rules = parseTruncationRules('.a { overflow: hidden; text-overflow: ellipsis; }')
      expect(rules).toHaveLength(1)
      expect(rules[0].display).toBeNull()
      expect(rules[0].classNames).toEqual(['a'])
    })

    test('能识别出 display 的值（含 flex 这种"写了也白写"的）', () => {
      expect(parseTruncationRules('.a { display: flex; text-overflow: ellipsis; }')[0].display).toBe('flex')
      expect(parseTruncationRules('.a { display: block; text-overflow: ellipsis; }')[0].display).toBe('block')
    })

    test('注释里的 display 不算数（否则一句注释就能骗过判据）', () => {
      const rules = parseTruncationRules('.a { /* display: block; */ text-overflow: ellipsis; }')
      expect(rules[0].display).toBeNull()
    })

    test('分组选择器取全部 class，不只最后一个', () => {
      const rules = parseTruncationRules('.a, .b, .c { text-overflow: ellipsis; }')
      expect(rules[0].classNames.sort()).toEqual(['a', 'b', 'c'])
    })

    test('同块多个 display 取最后一个（CSS 后者覆盖前者）', () => {
      const r = parseTruncationRules('.a { display: block; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; }')
      expect(r[0].display).toBe('-webkit-box')
    })

    test('-webkit-line-clamp 也被纳入', () => {
      const rules = parseTruncationRules('.a { display: -webkit-box; -webkit-line-clamp: 2; }')
      expect(rules[0].hasLineClamp).toBe(true)
    })

    test('hostTags 能跨过属性值里的 `>`（wx:if="{{a > b}}"）', () => {
      const tmp = path.join(ROOT, '__tests__/compile/.tmp-hosttags.wxml')
      fs.writeFileSync(tmp, '<text wx:if="{{item.n > 1}}" class="probe-cls">x</text>\n')
      try {
        expect(hostTags([tmp], 'probe-cls').has('text')).toBe(true)
      } finally {
        fs.unlinkSync(tmp)
      }
    })

    test('hostTags 的 class 匹配有边界（不把 foo-bar 当成 foo）', () => {
      const tmp = path.join(ROOT, '__tests__/compile/.tmp-boundary.wxml')
      fs.writeFileSync(tmp, '<view class="probe-cls-row"><text class="probe-cls">x</text></view>\n')
      try {
        expect([...hostTags([tmp], 'probe-cls')]).toEqual(['text'])
        expect([...hostTags([tmp], 'probe-cls-row')]).toEqual(['view'])
      } finally {
        fs.unlinkSync(tmp)
      }
    })

    test('全仓确实扫得到规则（为 0 说明 walk/解析坏了）', () => {
      const total = wxssFiles.reduce(
        (n, f) => n + parseTruncationRules(fs.readFileSync(f, 'utf-8')).length,
        0,
      )
      expect(total).toBeGreaterThan(5)
    })
  })
})
