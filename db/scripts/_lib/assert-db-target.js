'use strict'

/**
 * assert-db-target.js — 运维脚本的「连接串目标断言」唯一实现（issue #151）。
 *
 * 为什么需要它：已弃用的旧库 `47.113.202.7:5433/fengyu_wxapp` **至今仍可连通**，数据停在
 * 2026-08-24，连上不报错、只是安静地给旧数据。所以 `db/CLAUDE.md` 规定运维脚本必须
 * 「显式传 DATABASE_URL 并断言 host/port/dbname」，不给任何默认值、也不接受白名单外的目标。
 *
 * 为什么不能只用正则：PostgreSQL 连接串的 query 参数**优先级高于 URL authority**
 * （pg-connection-string 源码注释："Only set the host if there is no equivalent query param"），
 * 于是有两层绕过：
 *   1. `?host=47.113.202.7` —— authority 看着是 101，实连 47；
 *   2. `?%68ost=47.113.202.7` —— 百分号编码，正则匹配字面 `host=` 也挡不住，
 *      而解析器会还原成 `host`。编码形式无穷（%68/%48/大小写混合…），正则枚举不完。
 * 因此 query 一律交给 `new URL().searchParams` 判断——它会自动解码，两层绕过都挡得住。
 * 正则只负责 authority 部分（scheme / host / port / dbname）。
 */

// 只负责 authority；query 的合法性由 searchParams 单独判定（见上）。
const DB_TARGET_RE =
  /^postgres(?:ql)?:\/\/[^@/]*@(101\.34\.242\.103|118\.178\.196\.26):5433\/fengyu_wxapp(?:\?[^#]*)?$/

// libpq 中可覆盖连接目标的参数——出现在 query 里即视为试图绕过 authority 断言。
const OVERRIDE_KEYS = Object.freeze([
  'host',
  'hostaddr',
  'port',
  'dbname',
  'database',
  'options',
  'service',
  'passfile',
])

const HINT =
  'dev=101.34.242.103:5433/fengyu_wxapp / prod=118.178.196.26:5433/fengyu_wxapp'

/** 目标是否在白名单内（不抛错，供测试与调用方复用）。 */
function isAllowedDbTarget(raw) {
  const s = String(raw ?? '').trim()
  if (!DB_TARGET_RE.test(s)) return false
  let url
  try {
    url = new URL(s)
  } catch {
    return false
  }
  // searchParams 会把 %68ost 这类编码键还原为 host，故必须在这里判而不是靠正则
  return !OVERRIDE_KEYS.some((key) => url.searchParams.has(key))
}

/**
 * 校验失败即打印原因并退出（fail-closed）。
 * ⚠️ 调用方务必包在 `if (require.main === module)` 里：本目录部分脚本的导出函数会被
 * `__tests__` require，顶层 exit 会直接打断测试进程。
 */
function assertDbTargetOrExit(raw, varName = 'DATABASE_URL') {
  if (isAllowedDbTarget(raw)) return String(raw).trim()
  console.error(`✗ ${varName} 必须显式指向 ${HINT}`)
  const s = String(raw ?? '').trim()
  if (s) {
    try {
      const url = new URL(s)
      const hit = OVERRIDE_KEYS.filter((key) => url.searchParams.has(key))
      if (hit.length) {
        console.error(`  （query 参数 ${hit.join(', ')} 会覆盖连接目标，一律拒绝）`)
      }
    } catch {
      console.error('  （无法解析为合法 URL）')
    }
  }
  process.exit(1)
}

module.exports = { DB_TARGET_RE, OVERRIDE_KEYS, isAllowedDbTarget, assertDbTargetOrExit }
