/**
 * WXML 绑定完整性测试
 * 检查所有页面和组件 .wxml 中的事件 handler 在对应 .ts 文件中都有定义
 */
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const APP_JSON = path.join(ROOT, 'app.json')

function getAllPages(): string[] {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf-8'))
  const pages = [...(appJson.pages || [])]
  for (const sub of appJson.subpackages || appJson.subPackages || []) {
    for (const p of (sub as any).pages || []) {
      pages.push(`${(sub as any).root}/${p}`)
    }
  }
  return pages
}

/** 扫描 components/ 目录下的自定义组件 */
function getAllComponents(): string[] {
  const compsDir = path.join(ROOT, 'components')
  if (!fs.existsSync(compsDir)) return []
  const result: string[] = []
  for (const dir of fs.readdirSync(compsDir)) {
    const jsonPath = path.join(compsDir, dir, `${dir}.json`)
    if (!fs.existsSync(jsonPath)) continue
    try {
      const json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
      if (json.component) result.push(`components/${dir}/${dir}`)
    } catch { /* skip */ }
  }
  return result
}

function getAllTargets(): string[] {
  return [...getAllPages(), ...getAllComponents()]
}

function extractWxmlHandlers(wxmlContent: string): Set<string> {
  const handlers = new Set<string>()
  const re = /(?:bind:|catch:|mut-bind:|bind|catch)[\w-]+=["'](\w+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(wxmlContent)) !== null) {
    handlers.add(m[1])
  }
  return handlers
}

/** 提取 Page({}) 顶层方法（2 空格缩进） */
function extractPageMethods(tsContent: string): Set<string> {
  const methods = new Set<string>()
  const re = /^ {2}(?:async\s+)?(\w+)\s*[\(:{,]/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(tsContent)) !== null) {
    methods.add(m[1])
  }
  return methods
}

/** 提取 Component methods:{} 块中的方法（4 空格缩进） */
function extractComponentMethods(tsContent: string): Set<string> {
  const methods = new Set<string>()
  const re = /^ {4}(?:async\s+)?(\w+)\s*[\(:{,]/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(tsContent)) !== null) {
    methods.add(m[1])
  }
  return methods
}

describe('WXML 事件绑定完整性', () => {
  const targets = getAllTargets()

  for (const target of targets) {
    const wxmlPath = path.join(ROOT, target + '.wxml')
    const tsPath = path.join(ROOT, target + '.ts')

    if (!fs.existsSync(wxmlPath) || !fs.existsSync(tsPath)) continue

    const isComponent = target.startsWith('components/')

    test(`${target} — 所有 handler 绑定有效`, () => {
      const wxmlContent = fs.readFileSync(wxmlPath, 'utf-8')
      const tsContent = fs.readFileSync(tsPath, 'utf-8')

      const handlers = extractWxmlHandlers(wxmlContent)
      const methods = isComponent
        ? extractComponentMethods(tsContent)
        : extractPageMethods(tsContent)

      const missing: string[] = []
      for (const handler of handlers) {
        if (!methods.has(handler)) {
          missing.push(handler)
        }
      }

      if (missing.length > 0) {
        throw new Error(
          `WXML binds handler(s) not found in TS: ${missing.join(', ')}`
        )
      }
    })
  }
})

describe('手机号快速验证防重复守卫', () => {
  test('所有 getPhoneNumber 按钮均有禁用态，且页面 handler 有同步锁', () => {
    const violations: string[] = []
    let buttonCount = 0

    for (const target of getAllTargets()) {
      const wxmlPath = path.join(ROOT, target + '.wxml')
      const tsPath = path.join(ROOT, target + '.ts')
      if (!fs.existsSync(wxmlPath) || !fs.existsSync(tsPath)) continue

      const wxmlContent = fs.readFileSync(wxmlPath, 'utf-8')
      const phoneButtons = wxmlContent.match(
        /<button\b(?=[^>]*\bopen-type=["']getPhoneNumber["'])[^>]*>/g
      ) || []
      if (phoneButtons.length === 0) continue

      buttonCount += phoneButtons.length
      for (const tag of phoneButtons) {
        if (!/\bdisabled=["']\{\{\s*phoneBinding\s*\}\}["']/.test(tag)) {
          violations.push(`${target}: getPhoneNumber 按钮缺少 phoneBinding disabled`)
        }
        if (!/\bloading=["']\{\{\s*phoneBinding\s*\}\}["']/.test(tag)) {
          violations.push(`${target}: getPhoneNumber 按钮缺少 phoneBinding loading`)
        }
      }

      const tsContent = fs.readFileSync(tsPath, 'utf-8')
      if (!/phoneBinding:\s*false/.test(tsContent)) {
        violations.push(`${target}: data 缺少 phoneBinding 初始态`)
      }
      if (!/if\s*\(this\.data\.phoneBinding\)\s*return/.test(tsContent)) {
        violations.push(`${target}: handler 缺少 phoneBinding 重入守卫`)
      }
    }

    expect(buttonCount).toBeGreaterThan(0)
    expect(violations).toEqual([])
  })
})

describe('WXML 语法基础验证', () => {
  const targets = getAllTargets()

  for (const target of targets) {
    const wxmlPath = path.join(ROOT, target + '.wxml')
    if (!fs.existsSync(wxmlPath)) continue

    test(`${target} — WXML 标签闭合正确`, () => {
      const content = fs.readFileSync(wxmlPath, 'utf-8')

      // 检查 wx:for 不缺 wx:key
      const forWithoutKey = content.match(/<[^>]+wx:for[^>]+(?!wx:key)[^>]*>/g)
      if (forWithoutKey) {
        for (const tag of forWithoutKey) {
          if (!tag.includes('wx:key')) {
            throw new Error(`wx:for without wx:key: ${tag.slice(0, 80)}...`)
          }
        }
      }

      // 检查未闭合的 mustache
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const opens = (line.match(/\{\{/g) || []).length
        const closes = (line.match(/\}\}/g) || []).length
        if (opens !== closes) {
          const context = lines.slice(Math.max(0, i - 2), i + 3).join('\n')
          const ctxOpens = (context.match(/\{\{/g) || []).length
          const ctxCloses = (context.match(/\}\}/g) || []).length
          if (ctxOpens !== ctxCloses) {
            throw new Error(`Unmatched mustache braces at line ${i + 1}: ${line.trim()}`)
          }
        }
      }
    })
  }
})

describe('页面/组件 JSON 组件注册完整性', () => {
  const targets = getAllTargets()

  for (const target of targets) {
    const jsonPath = path.join(ROOT, target + '.json')
    const wxmlPath = path.join(ROOT, target + '.wxml')
    if (!fs.existsSync(jsonPath) || !fs.existsSync(wxmlPath)) continue

    test(`${target} — WXML 使用的自定义组件已注册`, () => {
      const pageJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
      const registered = new Set(Object.keys(pageJson.usingComponents || {}))
      const wxmlContent = fs.readFileSync(wxmlPath, 'utf-8')

      // 微信小程序内置带连字符组件（无需注册）
      const BUILTIN_TAGS = new Set([
        'scroll-view', 'cover-view', 'cover-image', 'movable-view', 'movable-area',
        'match-media', 'rich-text', 'picker-view', 'picker-view-column',
        'live-player', 'live-pusher', 'ad-custom', 'web-view', 'page-meta',
        'navigation-bar', 'open-data', 'official-account', 'channel-live',
        'channel-video', 'root-portal', 'swiper-item',
      ])

      const tagRe = /<(van-[\w-]+|[a-z]+-[\w-]+)/g
      const usedTags = new Set<string>()
      let m: RegExpExecArray | null
      while ((m = tagRe.exec(wxmlContent)) !== null) {
        usedTags.add(m[1])
      }

      const unregistered: string[] = []
      for (const tag of usedTags) {
        if (BUILTIN_TAGS.has(tag)) continue
        if (!registered.has(tag)) {
          unregistered.push(tag)
        }
      }

      if (unregistered.length > 0) {
        throw new Error(
          `WXML uses unregistered component(s): ${unregistered.join(', ')}`
        )
      }
    })
  }
})
