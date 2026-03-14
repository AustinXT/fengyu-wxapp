/**
 * WXML 编译错误检测
 *
 * 补充 wxml-bindings.test.ts，覆盖以下检查：
 * 1. 标签配对（开闭标签匹配 — 最常见的编译错误来源）
 * 2. wx: 指令合法性（拼写错误检测）
 * 3. 同一标签重复属性
 * 4. 组件注册路径可达性（JSON 中声明的路径确实存在）
 * 5. 导航目标有效性（navigateTo 指向 app.json 中存在的页面）
 */
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const APP_JSON = path.join(ROOT, 'app.json')

// ——————————————————————————————————————
// 公共工具
// ——————————————————————————————————————

function getAllPages(): string[] {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf-8'))
  const pages = [...(appJson.pages || [])]
  for (const sub of appJson.subPackages || []) {
    for (const p of (sub as any).pages || []) {
      pages.push(`${(sub as any).root}/${p}`)
    }
  }
  return pages
}

/** 清理 WXML 以便安全地做标签解析（保留行号） */
function cleanForParsing(content: string): string {
  return content
    // 去除注释
    .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
    // 去除 WXS 块（内含 JS 代码，不是 WXML）
    .replace(/<wxs[^>]*>[\s\S]*?<\/wxs>/g, m => m.replace(/[^\n]/g, ' '))
    // 去除 mustache 表达式（避免内部的 > 干扰标签解析）
    .replace(/\{\{[\s\S]*?\}\}/g, m => m.replace(/[^\n]/g, '_'))
}

/** 从字符偏移量算行号（1-indexed） */
function lineAt(content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

// ——————————————————————————————————————
// 1. 标签配对检查
// ——————————————————————————————————————

/** 不强制要求闭合的 WXML 元素（容忍 <input> 不写 /） */
const WXML_VOID_ELEMENTS = new Set(['input', 'image', 'import', 'include'])

function checkTagBalance(content: string): string[] {
  const cleaned = cleanForParsing(content)
  const errors: string[] = []
  const stack: { name: string; line: number }[] = []

  const tagRe = /<(\/?)([a-zA-Z][\w-]*)[^>]*>/g
  let m: RegExpExecArray | null

  while ((m = tagRe.exec(cleaned)) !== null) {
    const isClosing = m[1] === '/'
    const tagName = m[2]
    const selfClosing = m[0].endsWith('/>')
    const line = lineAt(cleaned, m.index)

    if (selfClosing) continue
    if (WXML_VOID_ELEMENTS.has(tagName)) continue // 无论开/闭都跳过

    if (isClosing) {
      if (stack.length === 0) {
        errors.push(`第 ${line} 行: 多余闭合标签 </${tagName}>`)
        continue
      }

      const top = stack[stack.length - 1]
      if (top.name === tagName) {
        stack.pop()
      } else {
        // 尝试在栈中向下查找匹配
        let found = -1
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === tagName) {
            found = i
            break
          }
        }
        if (found >= 0) {
          // 报告中间未闭合的标签
          for (let i = stack.length - 1; i > found; i--) {
            errors.push(
              `第 ${stack[i].line} 行: 未闭合标签 <${stack[i].name}>`
            )
          }
          stack.splice(found) // 从 found 开始全部弹出（含 found）
        } else {
          errors.push(`第 ${line} 行: </${tagName}> 找不到匹配的开标签`)
        }
      }
    } else {
      stack.push({ name: tagName, line })
    }
  }

  for (const item of stack) {
    errors.push(`第 ${item.line} 行: 未闭合标签 <${item.name}>`)
  }

  return errors
}

// ——————————————————————————————————————
// 2. wx: 指令合法性
// ——————————————————————————————————————

const VALID_WX_DIRECTIVES = new Set([
  'wx:if',
  'wx:elif',
  'wx:else',
  'wx:for',
  'wx:for-item',
  'wx:for-index',
  'wx:key',
])

function checkWxDirectives(content: string): string[] {
  const errors: string[] = []
  // 仅去注释，保留 mustache（指令不在 mustache 里）
  const cleaned = content.replace(
    /<!--[\s\S]*?-->/g,
    m => m.replace(/[^\n]/g, ' ')
  )
  const lines = cleaned.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const re = /\b(wx:[a-zA-Z][\w-]*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(lines[i])) !== null) {
      if (!VALID_WX_DIRECTIVES.has(m[1])) {
        errors.push(`第 ${i + 1} 行: 未知指令 "${m[1]}"`)
      }
    }
  }

  return errors
}

// ——————————————————————————————————————
// 3. 重复属性检测
// ——————————————————————————————————————

function checkDuplicateAttributes(content: string): string[] {
  const errors: string[] = []
  const cleaned = cleanForParsing(content)

  // 只匹配开标签（不匹配 </xxx>）
  const tagRe = /<(?!\/)([a-zA-Z][\w-]*)([^>]*)>/g
  let m: RegExpExecArray | null

  while ((m = tagRe.exec(cleaned)) !== null) {
    const tagName = m[1]
    const attrs = m[2]
    if (!attrs.trim()) continue

    const line = lineAt(cleaned, m.index)
    const attrRe = /\s([\w:-]+)\s*=/g
    const seen = new Set<string>()
    let am: RegExpExecArray | null

    while ((am = attrRe.exec(attrs)) !== null) {
      if (seen.has(am[1])) {
        errors.push(`第 ${line} 行: <${tagName}> 重复属性 "${am[1]}"`)
      }
      seen.add(am[1])
    }
  }

  return errors
}

// ——————————————————————————————————————
// 4. 组件路径可达性
// ——————————————————————————————————————

function checkComponentPaths(jsonPath: string): string[] {
  if (!fs.existsSync(jsonPath)) return []

  const errors: string[] = []
  const pageJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
  const components = pageJson.usingComponents || {}
  const jsonDir = path.dirname(jsonPath)

  for (const [name, compPath] of Object.entries(components)) {
    const p = compPath as string
    let resolvedBase: string

    if (p.startsWith('.') || p.startsWith('/')) {
      resolvedBase = path.resolve(jsonDir, p)
    } else {
      // npm 包路径 — 在 miniprogram_npm/ 中查找
      resolvedBase = path.join(ROOT, 'miniprogram_npm', p)
    }

    const exists = ['.json', '.js', '.wxml'].some(ext =>
      fs.existsSync(resolvedBase + ext)
    )

    if (!exists) {
      errors.push(`组件 "${name}" 路径不可达: ${p}`)
    }
  }

  return errors
}

// ——————————————————————————————————————
// 5. 导航目标有效性
// ——————————————————————————————————————

function extractNavigationTargets(
  tsContent: string
): { path: string; line: number }[] {
  const targets: { path: string; line: number }[] = []
  const lines = tsContent.split('\n')

  for (let i = 0; i < lines.length; i++) {
    if (/wx\.(navigateTo|redirectTo|reLaunch|switchTab)/.test(lines[i])) {
      // url 可能在同一行或下面几行
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        const urlMatch = lines[j].match(/url:\s*[`'"](\/[\w\-\/]+)/)
        if (urlMatch) {
          targets.push({ path: urlMatch[1].substring(1), line: j + 1 })
          break
        }
      }
    }
  }

  return targets
}

// ——————————————————————————————————————
// 测试套件
// ——————————————————————————————————————

describe('WXML 标签配对', () => {
  const pages = getAllPages()

  for (const page of pages) {
    const wxmlPath = path.join(ROOT, page + '.wxml')
    if (!fs.existsSync(wxmlPath)) continue

    test(`${page} — 开闭标签匹配`, () => {
      const content = fs.readFileSync(wxmlPath, 'utf-8')
      const errors = checkTagBalance(content)
      if (errors.length > 0) {
        throw new Error(`标签配对错误:\n${errors.join('\n')}`)
      }
    })
  }
})

describe('wx: 指令合法性', () => {
  const pages = getAllPages()

  for (const page of pages) {
    const wxmlPath = path.join(ROOT, page + '.wxml')
    if (!fs.existsSync(wxmlPath)) continue

    test(`${page} — 仅使用合法 wx: 指令`, () => {
      const content = fs.readFileSync(wxmlPath, 'utf-8')
      const errors = checkWxDirectives(content)
      if (errors.length > 0) {
        throw new Error(`未知 wx: 指令:\n${errors.join('\n')}`)
      }
    })
  }
})

describe('WXML 属性重复检测', () => {
  const pages = getAllPages()

  for (const page of pages) {
    const wxmlPath = path.join(ROOT, page + '.wxml')
    if (!fs.existsSync(wxmlPath)) continue

    test(`${page} — 无重复属性`, () => {
      const content = fs.readFileSync(wxmlPath, 'utf-8')
      const errors = checkDuplicateAttributes(content)
      if (errors.length > 0) {
        throw new Error(`重复属性:\n${errors.join('\n')}`)
      }
    })
  }
})

describe('组件路径可达性', () => {
  const pages = getAllPages()

  for (const page of pages) {
    const jsonPath = path.join(ROOT, page + '.json')
    if (!fs.existsSync(jsonPath)) continue

    test(`${page} — 注册组件路径有效`, () => {
      const errors = checkComponentPaths(jsonPath)
      if (errors.length > 0) {
        throw new Error(`组件路径不可达:\n${errors.join('\n')}`)
      }
    })
  }
})

describe('导航目标有效性', () => {
  const allPages = new Set(getAllPages())
  const pages = getAllPages()

  for (const page of pages) {
    const tsPath = path.join(ROOT, page + '.ts')
    if (!fs.existsSync(tsPath)) continue

    test(`${page} — 导航目标页面存在`, () => {
      const tsContent = fs.readFileSync(tsPath, 'utf-8')
      const targets = extractNavigationTargets(tsContent)
      if (targets.length === 0) return // 无导航调用，跳过

      const invalid: string[] = []
      for (const target of targets) {
        if (!allPages.has(target.path)) {
          invalid.push(
            `第 ${target.line} 行: 导航目标 "${target.path}" 不在 app.json 中`
          )
        }
      }

      if (invalid.length > 0) {
        throw new Error(`无效导航目标:\n${invalid.join('\n')}`)
      }
    })
  }
})
