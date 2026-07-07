

const pg = require('../db/pg')
const { invalidateCache } = require('../utils/config')


async function banners(ctx) {
  const rows = await pg.query(
    `SELECT key, value, EXTRACT(EPOCH FROM updated_at) * 1000 AS v
     FROM system_configs WHERE key IN ('banner_count', 'banner_images')`
  )
  let count = 0
  let v = 0
  const cntRow = rows.find((r) => r.key === 'banner_count')
  if (cntRow) {
    count = parseInt(cntRow.value, 10) || 0
    v = Math.floor(Number(cntRow.v)) || 0
  } else {
    
    const imgRow = rows.find((r) => r.key === 'banner_images')
    if (imgRow) {
      try { count = JSON.parse(imgRow.value).length } catch {  }
      v = Math.floor(Number(imgRow.v)) || 0
    }
  }
  ctx.result = { count, v }
}


async function fengyuguan(ctx) {
  const rows = await pg.query(
    `SELECT value, EXTRACT(EPOCH FROM updated_at) * 1000 AS v
     FROM system_configs WHERE key = 'fengyuguan_image'`
  )
  ctx.result = {
    url: rows.length > 0 ? (rows[0].value || '') : '',
    v: rows.length > 0 ? (Math.floor(Number(rows[0].v)) || 0) : 0,
  }
}


async function shareGift(ctx) {
  const disabled = { enabled: false }
  const rows = await pg.query(
    "SELECT value FROM system_configs WHERE key = 'share_gift_config'"
  )
  if (rows.length === 0 || !rows[0].value) {
    ctx.result = disabled
    return
  }
  let cfg
  try {
    cfg = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value
  } catch (e) {
    ctx.result = disabled
    return
  }
  if (!cfg || !cfg.enabled) {
    ctx.result = disabled
    return
  }
  ctx.result = {
    enabled: true,
    percent: Number(cfg.percent) > 0 ? Number(cfg.percent) : 0.15,
    minFaceValue: Number(cfg.minFaceValue) > 0 ? Number(cfg.minFaceValue) : 1,
    maxFaceValue: Number(cfg.maxFaceValue) > 0 ? Number(cfg.maxFaceValue) : 500,
    validityDays: Number(cfg.validityDays) > 0 ? Number(cfg.validityDays) : 90,
  }
}


async function consumeAgreement(ctx) {
  const fallback = { title: '服务消费协议', content: '', v: 0 }
  const rows = await pg.query(
    "SELECT value, EXTRACT(EPOCH FROM updated_at) * 1000 AS v FROM system_configs WHERE key = 'consume_agreement'"
  )
  if (rows.length === 0 || !rows[0].value) {
    ctx.result = fallback
    return
  }
  let cfg
  try {
    cfg = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value
  } catch (e) {
    ctx.result = fallback
    return
  }
  if (!cfg || typeof cfg !== 'object') {
    ctx.result = fallback
    return
  }
  const title = typeof cfg.title === 'string' && cfg.title.trim() ? cfg.title.trim() : '服务消费协议'
  const content = typeof cfg.content === 'string' ? cfg.content : ''
  ctx.result = { title, content, v: Math.floor(Number(rows[0].v)) || 0 }
}


async function invalidateConfig(ctx) {
  invalidateCache()
  ctx.result = { success: true }
}

module.exports = { banners, fengyuguan, shareGift, consumeAgreement, invalidateConfig }
