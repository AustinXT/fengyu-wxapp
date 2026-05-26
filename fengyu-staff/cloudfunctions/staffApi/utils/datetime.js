/**
 * 东八区（Asia/Shanghai）日期工具。
 *
 * 注意：`new Date().toISOString()` 永远返回 UTC，与进程时区无关，
 * 直接 `.slice(0,10)` 取"今天"会在北京时间凌晨 00:00–08:00 回退到前一天。
 * 这里用纯 UTC 算术 +8h，不依赖 process.env.TZ，结果稳定。
 *
 * 跨端各自保留独立副本（见根 CLAUDE.md「禁止跨端共享代码目录」）。
 */

/** 东八区日期字符串 YYYY-MM-DD（"今天"） */
function shanghaiDateStr(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 东八区 YYYYMMDD（8 位，sale_item 流水号等日期段用） */
function shanghaiYMD(date = new Date()) {
  return shanghaiDateStr(date).replace(/-/g, '')
}

/** 东八区 YYMMDD（6 位，订单号日期段用） */
function shanghaiYYMMDD(date = new Date()) {
  return shanghaiDateStr(date).slice(2).replace(/-/g, '')
}

module.exports = { shanghaiDateStr, shanghaiYMD, shanghaiYYMMDD }
