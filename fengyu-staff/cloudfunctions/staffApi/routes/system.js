'use strict'

const pg = require('../db/pg')
const { verifyHealthPayload } = require('../utils/system-health')

async function health(ctx) {
  verifyHealthPayload(ctx.event.payload, 'staffApi')
  await pg.query('SELECT 1 AS ok')
  ctx.result = { ok: true, checkedAt: new Date().toISOString() }
}

module.exports = { health }
