const pgModulePath = require.resolve('../../db/pg')

describe('db/pg OID parser', () => {
  test('OID 1082 保持 YYYY-MM-DD 自然日字符串，不转换为 Date', () => {
    const mockedModule = require.cache[pgModulePath]
    delete require.cache[pgModulePath]

    try {
      require('../../db/pg')
      const parser = require('pg').types.getTypeParser(1082)
      const value = parser('1990-03-15')

      expect(value).toBe('1990-03-15')
      expect(value).not.toBeInstanceOf(Date)
    } finally {
      delete require.cache[pgModulePath]
      if (mockedModule) require.cache[pgModulePath] = mockedModule
    }
  })
})
