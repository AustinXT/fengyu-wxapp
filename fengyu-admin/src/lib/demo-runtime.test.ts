import { describe, it, expect } from 'vitest'
import { assertDemoRuntime } from './demo-runtime'

const valid = {
  DEMO_MODE:'1', ENV_PROFILE:'demo', LAKALA_CLIENT_MODE:'mock', ALIYUN_OCR_MODE:'mock',
  DATABASE_URL:'postgresql://lxcoding_demo:random@demo-postgres:5432/lxcoding_demo',
}
describe('演示环境隔离', () => {
  it('允许独立模拟库', () => expect(() => assertDemoRuntime(valid)).not.toThrow())
  it.each([
    { DATABASE_URL:'postgresql://fengyu:password@101.34.242.103:5433/fengyu_wxapp' },
    { DATABASE_URL:valid.DATABASE_URL+'?host=118.178.196.26' },
    { E2E_DATABASE_URL:'postgresql://other/db' },
    { ENV_PROFILE:'prod' }, { DEMO_MODE:'0' }, { LAKALA_CLIENT_MODE:'real' },
    { TENCENTCLOUD_SECRETKEY:'real-secret' }, { WX_CLIENT_SECRET:'real-secret' },
  ])('拒绝业务库、连接覆盖与真实外部凭据 %j', override => {
    expect(() => assertDemoRuntime({...valid,...override})).toThrow()
  })
})
