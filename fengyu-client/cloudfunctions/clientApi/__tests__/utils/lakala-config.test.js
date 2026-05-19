/**
 * lakala-config 单元测试 — env 读取与启动预检
 */

const config = require('../../utils/lakala-config')

const REQUIRED = config.REQUIRED_VARS
const ENV_SNAPSHOT = {}

beforeEach(() => {
  for (const k of REQUIRED) {
    ENV_SNAPSHOT[k] = process.env[k]
    delete process.env[k]
  }
  ENV_SNAPSHOT.LAKALA_NOTIFY_URL = process.env.LAKALA_NOTIFY_URL
  ENV_SNAPSHOT.LAKALA_CALLBACK_IP_WHITELIST = process.env.LAKALA_CALLBACK_IP_WHITELIST
  ENV_SNAPSHOT.LAKALA_SM4_KEY = process.env.LAKALA_SM4_KEY
  ENV_SNAPSHOT.LAKALA_ENV = process.env.LAKALA_ENV
  delete process.env.LAKALA_NOTIFY_URL
  delete process.env.LAKALA_CALLBACK_IP_WHITELIST
  delete process.env.LAKALA_SM4_KEY
  delete process.env.LAKALA_ENV
})

afterEach(() => {
  for (const k of Object.keys(ENV_SNAPSHOT)) {
    if (ENV_SNAPSHOT[k] === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = ENV_SNAPSHOT[k]
    }
  }
})

function setAllRequired() {
  process.env.LAKALA_API_BASE = 'https://test.wsmsd.cn/sit/api'
  process.env.LAKALA_APPID = 'OP00000003'
  process.env.LAKALA_SERIAL_NO = '00dfba8194c41b84cf'
  process.env.LAKALA_PRIVATE_KEY_PEM = '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----'
  process.env.LAKALA_PLATFORM_CERT_PEM = '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----'
  process.env.LAKALA_DEFAULT_MERCHANT_NO = '822290059430BFA'
  process.env.LAKALA_DEFAULT_TERM_NO = 'D9261078'
}

describe('lakala-config', () => {
  describe('isReady / missingVars / assertReady', () => {
    it('returns false and lists all missing when nothing configured', () => {
      expect(config.isReady()).toBe(false)
      expect(config.missingVars()).toEqual(REQUIRED.slice())
    })

    it('returns true when all required vars set', () => {
      setAllRequired()
      expect(config.isReady()).toBe(true)
      expect(config.missingVars()).toEqual([])
    })

    it('assertReady throws INVALID_STATE listing missing vars', () => {
      process.env.LAKALA_API_BASE = 'https://x'
      expect(() => config.assertReady()).toThrow(/INVALID_STATE: LAKALA_NOT_CONFIGURED/)
    })

    it('assertReady passes when all set', () => {
      setAllRequired()
      expect(() => config.assertReady()).not.toThrow()
    })
  })

  describe('readConfig', () => {
    it('trims trailing slashes from apiBase', () => {
      setAllRequired()
      process.env.LAKALA_API_BASE = 'https://test.wsmsd.cn/sit/api///'
      const cfg = config.readConfig()
      expect(cfg.apiBase).toBe('https://test.wsmsd.cn/sit/api')
    })

    it('parses ipWhitelist as array, "*" sets ipWhitelistOpen true', () => {
      setAllRequired()
      process.env.LAKALA_CALLBACK_IP_WHITELIST = '58.246.131.244, 61.169.68.178'
      let cfg = config.readConfig()
      expect(cfg.ipWhitelist).toEqual(['58.246.131.244', '61.169.68.178'])
      expect(cfg.ipWhitelistOpen).toBe(false)

      process.env.LAKALA_CALLBACK_IP_WHITELIST = '*'
      cfg = config.readConfig()
      expect(cfg.ipWhitelist).toBeNull()
      expect(cfg.ipWhitelistOpen).toBe(true)
    })

    it('defaults env to trial when not release', () => {
      setAllRequired()
      let cfg = config.readConfig()
      expect(cfg.env).toBe('trial')

      process.env.LAKALA_ENV = 'release'
      cfg = config.readConfig()
      expect(cfg.env).toBe('release')

      process.env.LAKALA_ENV = 'production'
      cfg = config.readConfig()
      expect(cfg.env).toBe('trial')
    })
  })
})
