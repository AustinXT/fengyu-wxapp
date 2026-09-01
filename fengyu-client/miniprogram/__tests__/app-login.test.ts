import { callClientApi } from '../utils/cloud'

vi.mock('../utils/cloud', () => ({
  callClientApi: vi.fn(),
}))

vi.mock('../utils/cloud-env', () => ({
  getCloudEnv: vi.fn(() => 'test-env'),
}))

const mockedCallClientApi = vi.mocked(callClientApi)
let appDefinition: any

beforeAll(async () => {
  ;(globalThis as any).App = (definition: any) => {
    appDefinition = definition
  }
  await import('../app')
})

beforeEach(() => {
  ;(globalThis as any).wx.__resetStorage()
  mockedCallClientApi.mockReset()
  appDefinition.globalData = {
    userInfo: null,
    userId: '',
    boundStoreName: '',
    boundStoreId: '',
    boundMarketName: '',
    statusBarHeight: 44,
    navBarContentHeight: 44,
    navBarHeight: 88,
    logoHeight: 26,
    continuePayEnabled: true,
    pendingInviter: undefined,
  }
})

describe('App.syncLoginState OPENID 恢复登录', () => {
  test('退出态未 force 时跳过，不请求后端', async () => {
    ;(globalThis as any).wx.setStorageSync('clientLoggedOut', true)

    await expect(appDefinition.syncLoginState.call(appDefinition)).resolves.toBe('skipped')
    expect(mockedCallClientApi).not.toHaveBeenCalled()
  })

  test('force 后恢复已绑定账户并清除退出态', async () => {
    ;(globalThis as any).wx.setStorageSync('clientLoggedOut', true)
    mockedCallClientApi.mockResolvedValue({
      userId: 'FYGK-20260901-00001',
      phone: '13800000000',
      name: '测试顾客',
      avatarUrl: 'cloud://avatar',
      memberLevel: '金卡',
      customerType: '会员客',
      isMember: true,
      boundStoreId: 'STORE-001',
      boundStoreName: '测试门店',
      boundMarketName: '测试市场',
    })

    await expect(appDefinition.syncLoginState.call(appDefinition, true)).resolves.toBe('authenticated')

    expect(mockedCallClientApi).toHaveBeenCalledWith('auth.login', {})
    expect((globalThis as any).wx.getStorageSync('clientLoggedOut')).toBe('')
    expect((globalThis as any).wx.getStorageSync('phone')).toBe('13800000000')
    expect((globalThis as any).wx.getStorageSync('userId')).toBe('FYGK-20260901-00001')
    expect(appDefinition.globalData.boundStoreId).toBe('STORE-001')
  })

  test('服务端没有手机号时进入首次绑定态，不继续保持退出态', async () => {
    ;(globalThis as any).wx.setStorageSync('clientLoggedOut', true)
    ;(globalThis as any).wx.setStorageSync('phone', '13999999999')
    ;(globalThis as any).wx.setStorageSync('userId', 'STALE-USER')
    mockedCallClientApi.mockResolvedValue({
      userId: null,
      phone: null,
      name: null,
      avatarUrl: null,
      memberLevel: null,
      customerType: null,
      isMember: false,
      boundStoreId: null,
      boundStoreName: null,
      boundMarketName: null,
    })

    await expect(appDefinition.syncLoginState.call(appDefinition, true)).resolves.toBe('phone_required')
    expect((globalThis as any).wx.getStorageSync('clientLoggedOut')).toBe('')
    expect((globalThis as any).wx.getStorageSync('phone')).toBe('')
    expect((globalThis as any).wx.getStorageSync('userId')).toBe('')
  })

  test('恢复失败时保留退出态，避免误切到付费手机号授权', async () => {
    ;(globalThis as any).wx.setStorageSync('clientLoggedOut', true)
    mockedCallClientApi.mockRejectedValue(new Error('network down'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(appDefinition.syncLoginState.call(appDefinition, true)).resolves.toBe('failed')

    expect((globalThis as any).wx.getStorageSync('clientLoggedOut')).toBe(true)
    consoleSpy.mockRestore()
  })
})
