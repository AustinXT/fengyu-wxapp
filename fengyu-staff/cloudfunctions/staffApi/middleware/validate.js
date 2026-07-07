


function requireFields(...fields) {
  return (ctx, next) => {
    const missing = fields.filter(f => !ctx.event.payload || ctx.event.payload[f] === undefined)
    if (missing.length > 0) {
      throw new Error(`INVALID_PARAMS: 缺少必填字段: ${missing.join(', ')}`)
    }
    return next()
  }
}


function validateTypes(schema) {
  return (ctx, next) => {
    const payload = ctx.event.payload || {}
    for (const [field, type] of Object.entries(schema)) {
      const value = payload[field]
      if (value !== undefined) {
        const actualType = Array.isArray(value) ? 'array' : typeof value
        if (actualType !== type) {
          throw new Error(`INVALID_PARAMS: 字段 ${field} 类型错误,期望 ${type},实际 ${actualType}`)
        }
      }
    }
    return next()
  }
}

module.exports = {
  requireFields,
  validateTypes
}
