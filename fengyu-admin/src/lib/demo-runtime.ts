export function assertDemoRuntime(env: Record<string, string | undefined> = process.env): void {
  if (env.DEMO_MODE !== '1' || env.ENV_PROFILE !== 'demo') {
    throw new Error('演示镜像只允许在 demo 环境启动')
  }
  const url = new URL(env.DATABASE_URL || '')
  if (url.hostname !== 'demo-postgres' || url.port !== '5432' ||
      url.pathname !== '/lxcoding_demo' || url.search || url.hash ||
      url.username !== 'lxcoding_demo' || env.E2E_DATABASE_URL) {
    throw new Error('演示镜像只允许连接独立的 lxcoding_demo 数据库')
  }
  const forbidden = Object.keys(env).filter(key =>
    /^(TENCENTCLOUD_|STAFF_TENCENTCLOUD_|WX_CLIENT_|ALIYUN_ACCESS_KEY|LAKALA_(APPID|PRIVATE_KEY|PLATFORM_CERT)|CLOUDBASE_ENV_ID|STAFF_ENV_ID)/.test(key) && env[key],
  )
  if (forbidden.length || env.LAKALA_CLIENT_MODE !== 'mock' || env.ALIYUN_OCR_MODE !== 'mock') {
    throw new Error('演示环境禁止配置真实微信、CloudBase、支付或 OCR 凭据')
  }
}

export function assertExternalAvailable(): void {
  if (process.env.DEMO_MODE === '1') {
    throw new Error('INVALID_STATE: 演示环境不调用真实微信或支付服务，请使用线下模拟流程')
  }
}
