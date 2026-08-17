#!/usr/bin/env node
// 状态机 UPDATE 必须携带对应状态列的前置态守卫；
// 仅写资金/PII 列的 UPDATE 用 `// CAS-EXEMPT: <reason>` 注释豁免。
// 详见 notes/tickets/archives/2026-05-17-state-machine-cas-guard.md §5.2
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const STATE_COLUMNS_BY_TABLE = {
  sale_orders: ['status', 'allocation_status'],
  appointments: ['status'],
  service_orders: ['status', 'commission_status'],
  store_unbind_requests: ['status'],
  sale_order_payments: ['status', 'allocation_status'],
}
const TABLES = Object.keys(STATE_COLUMNS_BY_TABLE)
const UPDATE_TARGET_RE = new RegExp(
  `\\bUPDATE\\s+(?:public\\s*\\.\\s*)?(${TABLES.join('|')})\\b`,
  'gi',
)

function skipQuoted(source, start, quote) {
  let index = start + 1
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === quote) return index + 1
    index += 1
  }
  return source.length
}

function skipLineComment(source, start) {
  const end = source.indexOf('\n', start + 2)
  return end === -1 ? source.length : end + 1
}

function skipBlockComment(source, start) {
  const end = source.indexOf('*/', start + 2)
  return end === -1 ? source.length : end + 2
}

function skipTemplate(source, start) {
  let index = start + 1
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === '`') return index + 1
    if (source[index] === '$' && source[index + 1] === '{') {
      index = skipExpression(source, index + 2)
      continue
    }
    index += 1
  }
  return source.length
}

function skipExpression(source, start) {
  let depth = 1
  let index = start
  while (index < source.length) {
    const char = source[index]
    if (char === "'" || char === '"') {
      index = skipQuoted(source, index, char)
      continue
    }
    if (char === '`') {
      index = skipTemplate(source, index)
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index)
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index)
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return source.length
}

function readQuotedLiteral(source, start, quote) {
  let content = ''
  const offsets = []
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\' && index + 1 < source.length) {
      content += char + source[index + 1]
      offsets.push(index, index + 1)
      index += 2
      continue
    }
    if (char === quote) {
      return { content, offsets, start, end: index + 1 }
    }
    content += char
    offsets.push(index)
    index += 1
  }
  return { content, offsets, start, end: source.length }
}

function readTemplateLiteral(source, start) {
  let content = ''
  const offsets = []
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\' && index + 1 < source.length) {
      content += char + source[index + 1]
      offsets.push(index, index + 1)
      index += 2
      continue
    }
    if (char === '`') {
      return { content, offsets, start, end: index + 1 }
    }
    if (char === '$' && source[index + 1] === '{') {
      // SQL 参数值不影响关键词/守卫识别；保留一个空格并跳过完整 JS 表达式。
      content += ' '
      offsets.push(index)
      index = skipExpression(source, index + 2)
      continue
    }
    content += char
    offsets.push(index)
    index += 1
  }
  return { content, offsets, start, end: source.length }
}

/** 提取 JS/TS 源码中的完整字符串和模板字面量，排除注释内容。 */
export function extractJavaScriptStringLiterals(source) {
  const literals = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index)
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index)
      continue
    }
    if (char === "'" || char === '"') {
      const literal = readQuotedLiteral(source, index, char)
      literals.push(literal)
      index = literal.end
      continue
    }
    if (char === '`') {
      const literal = readTemplateLiteral(source, index)
      literals.push(literal)
      index = literal.end
      continue
    }
    index += 1
  }
  return literals
}

/**
 * 把 SQL 引号和注释内容遮成空格，只保留可执行结构；这样字符串中的 WHERE、
 * 分号或伪 UPDATE 不会改变当前语句边界和 CAS 判断。
 */
function maskSqlNonCode(sqlText) {
  const chars = [...sqlText]
  let index = 0
  while (index < chars.length) {
    if (chars[index] === '\\' && chars[index + 1] === '"') {
      // 双引号包裹的 JS 字符串会把 SQL 标识符写成 \"name\"；
      // 反斜杠只属于 JS 转义，运行时 SQL 中不存在，先遮掉再按标识符处理引号。
      chars[index] = ' '
      index += 1
      continue
    }
    if (chars[index] === "'") {
      chars[index] = ' '
      index += 1
      while (index < chars.length) {
        if (chars[index] === "'" && chars[index + 1] === "'") {
          chars[index] = chars[index + 1] = ' '
          index += 2
          continue
        }
        const isEnd = chars[index] === "'"
        if (chars[index] !== '\n') chars[index] = ' '
        index += 1
        if (isEnd) break
      }
      continue
    }
    if (chars[index] === '"') {
      // 双引号在 PostgreSQL 中包裹标识符，不是字符串。保留合法标识符字符，
      // 仅遮掉引号和标识符内不可能属于普通名称的字符，使
      // UPDATE "sale_orders" / SET "allocation_status" 仍能被识别，
      // 同时避免引号内分号被误当作语句终止符。
      chars[index] = ' '
      index += 1
      while (index < chars.length) {
        if (chars[index] === '"' && chars[index + 1] === '"') {
          chars[index] = chars[index + 1] = ' '
          index += 2
          continue
        }
        const isEnd = chars[index] === '"'
        if (isEnd) {
          chars[index] = ' '
        } else if (chars[index] !== '\n' && !/[a-z0-9_$]/i.test(chars[index])) {
          chars[index] = ' '
        }
        index += 1
        if (isEnd) break
      }
      continue
    }
    if (chars[index] === '-' && chars[index + 1] === '-') {
      while (index < chars.length && chars[index] !== '\n') {
        chars[index] = ' '
        index += 1
      }
      continue
    }
    if (chars[index] === '/' && chars[index + 1] === '*') {
      chars[index] = chars[index + 1] = ' '
      index += 2
      while (index < chars.length) {
        if (chars[index] === '*' && chars[index + 1] === '/') {
          chars[index] = chars[index + 1] = ' '
          index += 2
          break
        }
        if (chars[index] !== '\n') chars[index] = ' '
        index += 1
      }
      continue
    }
    index += 1
  }
  return chars.join('')
}

function hasLeadingCasExemption(source, literalStart) {
  const lines = source.slice(0, literalStart).split('\n')
  const currentLinePrefix = lines.at(-1) || ''
  let commentLineIndex = lines.length - 2

  // 字面量与调用位于同一行时，前缀只能是尚未闭合的简单调用/赋值。
  // 若前缀已经出现闭合符、分号或另一段字符串，说明本行前面已有完整表达式；
  // 此时上一行注释不能继续豁免本行的第二条 SQL。
  if (currentLinePrefix.trim() !== '' && /[;)'"`\]}]/.test(currentLinePrefix)) {
    return false
  }

  // 常见多行调用：CAS 注释 → await client.query( → `UPDATE ...`。
  // 只允许跨过这一行纯调用包装，不能越过上一条 SQL/表达式继续复用豁免。
  if (currentLinePrefix.trim() === '') {
    const wrapperLine = lines.at(-2) || ''
    if (/^\s*(?:await\s+)?[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*\s*\(\s*$/i.test(wrapperLine)) {
      commentLineIndex -= 1
    }
  }

  const commentLine = lines[commentLineIndex] || ''
  return /^\s*(?:(?:\/\/)|(?:\/\*)|(?:\*))[^\n]*CAS-EXEMPT\b/.test(commentLine)
}

/** 返回指定源码中缺少状态 CAS 的 UPDATE 位置。 */
export function lintSource(source, file = '<inline>') {
  const findings = []
  for (const literal of extractJavaScriptStringLiterals(source)) {
    const masked = maskSqlNonCode(literal.content)
    UPDATE_TARGET_RE.lastIndex = 0
    for (const match of masked.matchAll(UPDATE_TARGET_RE)) {
      const updateAt = match.index ?? 0
      const terminatorAt = masked.indexOf(';', updateAt)
      const statementEnd = terminatorAt === -1 ? masked.length : terminatorAt + 1
      const statement = masked.slice(updateAt, statementEnd)
      const setMatch = /\bSET\b/i.exec(statement)
      if (!setMatch) continue
      const setAt = (setMatch.index ?? 0) + setMatch[0].length
      const whereMatch = /\bWHERE\b/i.exec(statement.slice(setAt))
      const whereAt = whereMatch == null ? -1 : setAt + (whereMatch.index ?? 0)
      const table = match[1].toLowerCase()
      const stateColumns = STATE_COLUMNS_BY_TABLE[table]
      const columnAlternation = stateColumns.join('|')
      const setClause = statement.slice(setAt, whereAt === -1 ? statement.length : whereAt)
      const assignmentRe = new RegExp(
        `(?:^|,)\\s*(?:[a-z_][a-z0-9_$]*\\s*\\.\\s*)?(${columnAlternation})\\s*=`,
        'gi',
      )
      const assignedStateColumns = new Set(
        [...setClause.matchAll(assignmentRe)].map((columnMatch) => columnMatch[1].toLowerCase()),
      )
      if (assignedStateColumns.size === 0) continue

      const guardedStateColumns = new Set()
      if (whereAt !== -1) {
        const guardRe = new RegExp(
          `\\b(?:[a-z_][a-z0-9_$]*\\s*\\.\\s*)?(${columnAlternation})\\s*`
            + `(?:=|IN\\b|IS\\s+NULL\\b|IS\\s+NOT\\s+DISTINCT\\s+FROM\\b)`,
          'gi',
        )
        for (const guardMatch of statement.slice(whereAt).matchAll(guardRe)) {
          guardedStateColumns.add(guardMatch[1].toLowerCase())
        }
      }
      // 一条 UPDATE 可能同时推进主状态和派生状态（例如服务完成时同步置提成已分配）；
      // 至少要对本次实际赋值的某个状态列做前置态 CAS，不能用无关状态列冒充守卫。
      const guarded = [...assignedStateColumns].some((column) => guardedStateColumns.has(column))
      const exempt = hasLeadingCasExemption(source, literal.start)
      if (guarded || exempt) continue

      const sourceOffset = literal.offsets[updateAt] ?? literal.start
      findings.push({
        file,
        line: source.slice(0, sourceOffset).split('\n').length,
        table,
      })
    }
  }
  return findings
}

// 用 git ls-files 列文件，避免依赖 glob 包
function listFiles() {
  const out = execSync(
    `git ls-files -- 'fengyu-admin/src/**/*.ts' 'fengyu-admin/src/**/*.tsx' 'fengyu-admin/src/**/*.js' 'fengyu-staff/cloudfunctions/**/*.js' 'fengyu-client/cloudfunctions/**/*.js'`,
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes('/__tests__/'))
    .filter((line) => !line.includes('/node_modules/'))
    .filter((line) => !/\.test\.[jt]sx?$/.test(line))
    .filter((line) => !/\.spec\.[jt]sx?$/.test(line))
}

export function runCli() {
  const findings = []
  for (const relativePath of listFiles()) {
    try {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8')
      findings.push(...lintSource(source, relativePath))
    } catch {
      // 文件在 git ls-files 与读取之间被删除时跳过；其他文件继续检查。
    }
  }

  for (const finding of findings) {
    console.error(`MISS-CAS-GUARD: ${finding.file}:${finding.line}`)
  }
  if (findings.length > 0) {
    console.error(`\n✘ ${findings.length} 处状态机 UPDATE 缺少 CAS 守卫或 CAS-EXEMPT 注释`)
    return 1
  }
  console.log('✔ 全部状态机 UPDATE 已携带 CAS 守卫或 CAS-EXEMPT 注释')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli()
}
