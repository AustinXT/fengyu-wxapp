/**
 * 认证路由测试
 * 覆盖：login（新/老用户）、bindPhone（CloudID/直传/重复授权幂等/历史补全/首绑守卫）、bindStore（有效/无效门店）、updateProfile（昵称/头像更新+字段截断）、uploadAvatar（成功/校验失败/用户不存在）
 */

const pg = globalThis.__mocks__.pg
const cloud = globalThis.__mocks__.cloud
const { createCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  // 清除路由和 auth 模块缓存
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/routes/auth') || key.includes('/middleware/auth')) {
      delete require.cache[key]
    }
  })
  routes = require('../../routes/auth')
})

describe('auth.login', () => {
  test('新访客：不建库行，返回 isNewUser=true, userId=null', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'new-openid' })
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx()
    await routes.login(ctx)

    expect(ctx.result.isNewUser).toBe(true)
    expect(ctx.result.userId).toBeNull()
    expect(ctx.result.phone).toBeNull()
    // 仅一次 SELECT，绝不 INSERT（避免顾客管理出现空壳档案）
    expect(pg.query).toHaveBeenCalledTimes(1)
    const allSql = pg.query.mock.calls.map(c => c[0]).join('\n')
    expect(allSql).not.toContain('INSERT INTO client_wechat_users')
  })

  test('老用户：更新登录时间，返回 isNewUser=false', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'existing-openid' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'user-001',
      phone: '13800001111',
      bound_store_id: 'store-001',
      bound_store_name: '凤御测试店',
      bound_market_name: '华东市场',
    }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx()
    await routes.login(ctx)

    expect(ctx.result.isNewUser).toBe(false)
    expect(ctx.result.userId).toBe('user-001')
    expect(ctx.result.phone).toBe('13800001111')
    expect(pg.query.mock.calls[1][0]).toContain('UPDATE client_wechat_users')
  })
})

describe('auth.bindPhone', () => {
  // 新调用序列：byOpenid SELECT → phone SELECT → (attach UPDATE | INSERT) → 订单回填 → legacy count
  test('walk-in 新客直传手机号 → 懒建库行', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })
    pg.query.mockResolvedValueOnce([])                  // byOpenid: 无行
    pg.query.mockResolvedValueOnce([])                  // byPhone: 无行
    pg.query.mockResolvedValueOnce([])                  // INSERT
    pg.query.mockResolvedValueOnce({ rowCount: 2 })     // 订单回填
    pg.query.mockResolvedValueOnce([{ cnt: 0 }])        // legacy count

    const ctx = createCtx({ payload: { phoneNumber: '13800001111' } })
    await routes.bindPhone(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.phone).toBe('13800001111')
    expect(ctx.result.updatedOrdersCount).toBe(2)
    // userId 由 generateUserId 现场生成（FYGK-* 前缀）
    expect(ctx.result.userId).toMatch(/^FYGK-/)
    const allSql = pg.query.mock.calls.map(c => c[0]).join('\n')
    expect(allSql).toContain('INSERT INTO client_wechat_users')
  })

  test('CloudID 方式 walk-in 绑定成功', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })
    pg.query.mockResolvedValueOnce([])                  // byOpenid
    pg.query.mockResolvedValueOnce([])                  // byPhone
    pg.query.mockResolvedValueOnce([])                  // INSERT
    pg.query.mockResolvedValueOnce({ rowCount: 0 })     // 订单回填
    pg.query.mockResolvedValueOnce([{ cnt: 0 }])        // legacy count

    const ctx = createCtx({
      payload: {},
      event: {
        phoneData: { data: { purePhoneNumber: '13900009999' } },
      },
    })
    await routes.bindPhone(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.phone).toBe('13900009999')
  })

  test('分享礼：walk-in 新客携带合法 inviterUserId → 写入邀请关系', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'new-invitee-openid' })
    pg.query.mockResolvedValueOnce([])                  // byOpenid
    pg.query.mockResolvedValueOnce([])                  // byPhone
    pg.query.mockResolvedValueOnce([])                  // INSERT
    pg.query.mockResolvedValueOnce({ rowCount: 1 })     // inviter UPDATE
    pg.query.mockResolvedValueOnce({ rowCount: 0 })     // 订单回填
    pg.query.mockResolvedValueOnce([{ cnt: 0 }])        // legacy count

    const ctx = createCtx({
      payload: {
        phoneNumber: '13900008888',
        inviterUserId: 'FYGK-20260424-00001',
      },
    })
    await routes.bindPhone(ctx)

    expect(ctx.result.success).toBe(true)
    const inviterCall = pg.query.mock.calls[3]
    expect(inviterCall[0]).toContain('inviter_user_id = $1')
    expect(inviterCall[0]).toContain('invited_at = $2')
    expect(inviterCall[0]).toContain('EXISTS')
    expect(inviterCall[1][0]).toBe('FYGK-20260424-00001')
    expect(inviterCall[1][2]).toBe(ctx.result.userId)
  })

  test('分享礼：已有手机号档案回流携带 inviterUserId → 不写邀请关系', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })
    pg.query.mockResolvedValueOnce([])                  // byOpenid
    pg.query.mockResolvedValueOnce([{ user_id: 'WF-CUST-9', openid: null }]) // byPhone
    pg.query.mockResolvedValueOnce([])                  // attach UPDATE
    pg.query.mockResolvedValueOnce({ rowCount: 1 })     // 订单回填
    pg.query.mockResolvedValueOnce([{ cnt: 0 }])        // legacy count

    const ctx = createCtx({
      payload: {
        phoneNumber: '13800001111',
        inviterUserId: 'FYGK-20260424-00001',
      },
    })
    await routes.bindPhone(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.userId).toBe('WF-CUST-9')
    const allSql = pg.query.mock.calls.map(c => c[0]).join('\n')
    expect(allSql).not.toContain('inviter_user_id')
  })

  test('孤儿档案回流：按 phone 命中 openid 为 NULL 的行 → attach openid（复用 user_id）', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })
    pg.query.mockResolvedValueOnce([])                  // byOpenid: 无行
    pg.query.mockResolvedValueOnce([{ user_id: 'WF-CUST-9', openid: null }]) // byPhone: 孤儿行
    pg.query.mockResolvedValueOnce([])                  // attach UPDATE
    pg.query.mockResolvedValueOnce({ rowCount: 1 })     // 订单回填
    pg.query.mockResolvedValueOnce([{ cnt: 0 }])        // legacy count

    const ctx = createCtx({ payload: { phoneNumber: '13800001111' } })
    await routes.bindPhone(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.userId).toBe('WF-CUST-9')  // 复用孤儿行 user_id，不新建
    const attachSql = pg.query.mock.calls[2][0]
    expect(attachSql).toContain('UPDATE client_wechat_users')
    expect(attachSql).toContain('openid = $1')
    // 不应 INSERT
    const allSql = pg.query.mock.calls.map(c => c[0]).join('\n')
    expect(allSql).not.toContain('INSERT INTO client_wechat_users')
  })

  test('手机号已被其他 openid 占用 → 拒绝', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })
    pg.query.mockResolvedValueOnce([])                  // byOpenid: 无行
    pg.query.mockResolvedValueOnce([{ user_id: 'user-other', openid: 'other-openid' }]) // byPhone: 他人已绑

    const ctx = createCtx({ payload: { phoneNumber: '13800001111' } })
    await expect(routes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已被其他用户绑定/)
  })

  test('缺少 phoneData 和 phoneNumber → 报错', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })

    const ctx = createCtx({ payload: {} })
    await expect(routes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*phoneData.*phoneNumber/)
  })

  test('CloudID 解密失败 → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })

    const ctx = createCtx({
      payload: {},
      event: {
        phoneData: { errCode: -1, errMsg: '解密失败' },
      },
    })
    await expect(routes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*解密失败/)
  })

  test('手机号授权登录：openid 已绑定同一手机号 → 幂等成功', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bound-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: '13800001111' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { phoneNumber: '13800001111' } })
    await routes.bindPhone(ctx)

    expect(ctx.result).toEqual({
      success: true,
      userId: 'user-001',
      phone: '13800001111',
      updatedOrdersCount: 0,
    })
    expect(pg.query).toHaveBeenCalledTimes(2)
    expect(pg.query.mock.calls[1][0]).toContain('UPDATE client_wechat_users')
    expect(pg.query.mock.calls[1][1][1]).toBe('user-001')
  })

  test('首绑守卫：openid 已绑定其他手机号 → INVALID_PARAMS（提示联系门店）', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bound-openid' })
    // byOpenid 返回 phone 已有值
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: '13800001111' }])

    const ctx = createCtx({ payload: { phoneNumber: '13911112222' } })
    await expect(routes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已绑定手机号.*门店/)
    // 命中守卫即止，仅一次 SELECT
    expect(pg.query).toHaveBeenCalledTimes(1)
  })
})

describe('auth.bindStore', () => {
  test('有效门店绑定成功', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'store-bind-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: '138' }])
    pg.query.mockResolvedValueOnce([{
      store_id: 'store-001',
      store_name: '凤御测试店',
      market_name: '华东市场',
    }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { storeId: 'store-001' } })
    await routes.bindStore(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.boundStoreId).toBe('store-001')
    expect(ctx.result.boundStoreName).toBe('凤御测试店')
  })

  test('推荐人姓名写入 promoter_employee_name', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'store-bind-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: '138' }])
    pg.query.mockResolvedValueOnce([{
      store_id: 'store-001',
      store_name: '凤御测试店',
      market_name: '华东市场',
    }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { storeId: 'store-001', promoterEmployeeName: '王推荐' } })
    await routes.bindStore(ctx)

    const [updateSql, updateParams] = pg.query.mock.calls[2]
    expect(updateSql).toContain('promoter_employee_name')
    expect(updateSql).not.toContain('promoter_employee_id')
    expect(updateParams).toContain('王推荐')
  })

  test('旧 promoterEmployeeId 参数按推荐人姓名写入新列', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'store-bind-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: '138' }])
    pg.query.mockResolvedValueOnce([{
      store_id: 'store-001',
      store_name: '凤御测试店',
      market_name: '华东市场',
    }])
    pg.query.mockResolvedValueOnce([])
    const ctx = createCtx({ payload: { storeId: 'store-001', promoterEmployeeId: '王旧版推荐' } })

    await routes.bindStore(ctx)

    const [updateSql, updateParams] = pg.query.mock.calls[2]
    expect(updateSql).toContain('promoter_employee_name')
    expect(updateSql).not.toContain('promoter_employee_id')
    expect(updateParams).toContain('王旧版推荐')
  })

  test('旧 promoterEmployeeId 为空时不阻断绑店', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'store-bind-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: '138' }])
    pg.query.mockResolvedValueOnce([{
      store_id: 'store-001',
      store_name: '凤御测试店',
      market_name: '华东市场',
    }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { storeId: 'store-001', promoterEmployeeId: undefined } })
    await routes.bindStore(ctx)

    expect(ctx.result.success).toBe(true)
    expect(pg.query.mock.calls[2][0]).not.toContain('promoter_employee_name')
  })

  test('两个推荐人字段内容不一致 → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'store-bind-openid' })
    const ctx = createCtx({
      payload: {
        storeId: 'store-001',
        promoterEmployeeName: '王新版推荐',
        promoterEmployeeId: '李旧版推荐',
      },
    })

    await expect(routes.bindStore(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*内容不一致/)
    expect(pg.query).not.toHaveBeenCalled()
  })

  test('超过 50 个字符的推荐人姓名 → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'store-bind-openid' })
    const ctx = createCtx({
      payload: { storeId: 'store-001', promoterEmployeeName: '推'.repeat(51) },
    })

    await expect(routes.bindStore(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不能超过50个字符/)
    expect(pg.query).not.toHaveBeenCalled()
  })

  test('无效门店 → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'store-bind-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: '138' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { storeId: 'invalid-store' } })
    await expect(routes.bindStore(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*门店不存在/)
  })

  test('缺少 storeId → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'store-bind-openid' })

    const ctx = createCtx({ payload: {} })
    await expect(routes.bindStore(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*storeId/)
  })

  test('未建档（无行）→ PHONE_REQUIRED（先绑手机号）', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'unknown-openid' })
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { storeId: 'store-001' } })
    await expect(routes.bindStore(ctx))
      .rejects.toThrow(/PHONE_REQUIRED/)
  })

  test('行存在但未绑手机号 → PHONE_REQUIRED', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'nophone-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: null }])

    const ctx = createCtx({ payload: { storeId: 'store-001' } })
    await expect(routes.bindStore(ctx))
      .rejects.toThrow(/PHONE_REQUIRED/)
  })

  test('分享礼：bindStore 即使传 inviterUserId 也不补写邀请关系', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'inv-openid-0' })
    pg.query.mockResolvedValueOnce([{ user_id: 'FYGK-20260424-00001', phone: '138' }])
    pg.query.mockResolvedValueOnce([{
      store_id: 'store-001',
      store_name: '凤御测试店',
      market_name: '华东市场',
    }])
    pg.query.mockResolvedValueOnce([])  // 主 UPDATE

    const ctx = createCtx({
      payload: { storeId: 'store-001', inviterUserId: 'FYGK-20260424-99999' },
    })
    await routes.bindStore(ctx)

    expect(ctx.result.success).toBe(true)
    expect(pg.query).toHaveBeenCalledTimes(3)
    const allSql = pg.query.mock.calls.map(c => c[0]).join('\n')
    expect(allSql).not.toContain('inviter_user_id')
  })
})

describe('auth.updateProfile', () => {
  test('更新昵称成功', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])  // SELECT
    pg.query.mockResolvedValueOnce([])                          // UPDATE

    const ctx = createCtx({ payload: { name: '张小美' } })
    await routes.updateProfile(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.name).toBe('张小美')
    const updateSql = pg.query.mock.calls[1][0]
    expect(updateSql).toContain('name = $')
    expect(updateSql).not.toContain('avatar_url')
  })

  test('更新头像 URL 成功', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { avatarUrl: 'https://cdn.example.com/avatar.jpg' } })
    await routes.updateProfile(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.avatarUrl).toBe('https://cdn.example.com/avatar.jpg')
    const updateSql = pg.query.mock.calls[1][0]
    expect(updateSql).toContain('avatar_url = $')
    expect(updateSql).not.toContain('name = $')
  })

  test('同时更新昵称和头像', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { name: '李小红', avatarUrl: 'https://cdn.example.com/img.png' } })
    await routes.updateProfile(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.name).toBe('李小红')
    expect(ctx.result.avatarUrl).toBe('https://cdn.example.com/img.png')
    const updateSql = pg.query.mock.calls[1][0]
    expect(updateSql).toContain('name = $')
    expect(updateSql).toContain('avatar_url = $')
  })

  test('name 超过 50 字截断', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])
    pg.query.mockResolvedValueOnce([])

    const longName = 'A'.repeat(80)
    const ctx = createCtx({ payload: { name: longName } })
    await routes.updateProfile(ctx)

    expect(ctx.result.name).toHaveLength(50)
  })

  test('avatarUrl 超过 500 字截断', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])
    pg.query.mockResolvedValueOnce([])

    const longUrl = 'https://cdn.example.com/' + 'x'.repeat(480)
    const ctx = createCtx({ payload: { avatarUrl: longUrl } })
    await routes.updateProfile(ctx)

    expect(ctx.result.avatarUrl).toHaveLength(500)
  })

  test('name 为空白字符串时不更新 name', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { name: '   ', avatarUrl: 'https://cdn.example.com/a.jpg' } })
    await routes.updateProfile(ctx)

    const updateSql = pg.query.mock.calls[1][0]
    expect(updateSql).not.toContain('name = $')
    expect(updateSql).toContain('avatar_url = $')
  })

  test('name 和 avatarUrl 都未提供 → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })

    const ctx = createCtx({ payload: {} })
    await expect(routes.updateProfile(ctx)).rejects.toThrow(/INVALID_PARAMS.*name.*avatarUrl/)
  })

  test('用户不存在 → UNAUTHORIZED', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'unknown-openid' })
    pg.query.mockResolvedValueOnce([])  // SELECT 返回空

    const ctx = createCtx({ payload: { name: '测试' } })
    await expect(routes.updateProfile(ctx)).rejects.toThrow(/UNAUTHORIZED.*用户不存在/)
  })
})

describe('auth.uploadAvatar', () => {
  // 注意：setup.js 的 mockCloud 默认不含 uploadFile，这里每个用例按需挂载 vi.fn()
  beforeEach(() => {
    cloud.uploadFile = vi.fn()
  })

  // 1px PNG 的 base64（>= 1 字节）
  const smallBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII='

  test('上传成功：写 COS + UPDATE avatar_url + 返回 fileID', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    cloud.uploadFile.mockResolvedValueOnce({ fileID: 'cloud://env/avatars/user-openid/1_abc.jpg' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])  // SELECT
    pg.query.mockResolvedValueOnce([])                          // UPDATE

    const ctx = createCtx({ payload: { base64: smallBase64, ext: 'jpg' } })
    await routes.uploadAvatar(ctx)

    expect(ctx.result.fileID).toBe('cloud://env/avatars/user-openid/1_abc.jpg')
    expect(ctx.result.avatarUrl).toBe('cloud://env/avatars/user-openid/1_abc.jpg')

    // cloudPath 含 openid 隔离前缀
    const uploadArg = cloud.uploadFile.mock.calls[0][0]
    expect(uploadArg.cloudPath).toMatch(/^avatars\/user-openid\/\d+_[a-z0-9]+\.jpg$/)
    expect(Buffer.isBuffer(uploadArg.fileContent)).toBe(true)

    // UPDATE SQL
    const updateSql = pg.query.mock.calls[1][0]
    expect(updateSql).toContain('UPDATE client_wechat_users')
    expect(updateSql).toContain('avatar_url = $1')
    expect(pg.query.mock.calls[1][1][0]).toBe('cloud://env/avatars/user-openid/1_abc.jpg')
  })

  test('ext 缺省时默认 jpg', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    cloud.uploadFile.mockResolvedValueOnce({ fileID: 'cloud://env/a.jpg' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { base64: smallBase64 } })
    await routes.uploadAvatar(ctx)

    const uploadArg = cloud.uploadFile.mock.calls[0][0]
    expect(uploadArg.cloudPath).toMatch(/\.jpg$/)
  })

  test('缺少 base64 → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    const ctx = createCtx({ payload: {} })
    await expect(routes.uploadAvatar(ctx)).rejects.toThrow(/INVALID_PARAMS.*base64/)
    expect(cloud.uploadFile).not.toHaveBeenCalled()
  })

  test('不支持的扩展名 → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    const ctx = createCtx({ payload: { base64: smallBase64, ext: 'gif' } })
    await expect(routes.uploadAvatar(ctx)).rejects.toThrow(/INVALID_PARAMS.*格式/)
    expect(cloud.uploadFile).not.toHaveBeenCalled()
  })

  test('图片超过 2MB → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    // 生成约 3MB 的 base64（解码后 ~ 2.25MB）
    const bigBuffer = Buffer.alloc(3 * 1024 * 1024, 0)
    const bigBase64 = bigBuffer.toString('base64')

    const ctx = createCtx({ payload: { base64: bigBase64, ext: 'png' } })
    await expect(routes.uploadAvatar(ctx)).rejects.toThrow(/INVALID_PARAMS.*2MB/)
    expect(cloud.uploadFile).not.toHaveBeenCalled()
  })

  test('base64 解码为空 → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    const ctx = createCtx({ payload: { base64: '!!!', ext: 'jpg' } })
    // '!!!' 在 base64 解码下得到空 Buffer
    await expect(routes.uploadAvatar(ctx)).rejects.toThrow(/INVALID_PARAMS.*头像数据解析失败/)
  })

  test('用户不存在 → UNAUTHORIZED', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'unknown-openid' })
    pg.query.mockResolvedValueOnce([])  // SELECT 返空

    const ctx = createCtx({ payload: { base64: smallBase64, ext: 'jpg' } })
    await expect(routes.uploadAvatar(ctx)).rejects.toThrow(/UNAUTHORIZED.*用户不存在/)
    expect(cloud.uploadFile).not.toHaveBeenCalled()
  })

  test('COS 未返回 fileID → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    cloud.uploadFile.mockResolvedValueOnce({})  // 缺 fileID
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])

    const ctx = createCtx({ payload: { base64: smallBase64, ext: 'jpg' } })
    await expect(routes.uploadAvatar(ctx)).rejects.toThrow(/INVALID_PARAMS.*上传失败/)
  })
})
