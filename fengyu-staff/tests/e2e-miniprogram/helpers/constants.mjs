// helpers/constants.mjs — L3 E2E 测试共享常量
// 命名空间：与 L2 Agent（TEST_E2E_L2_*）严格隔离

export const NAMESPACE = 'TEST_E2E_L3_';

// 测试身份 openid（必须配合云函数环境变量 ALLOW_TEST_OPENID=true 才能生效）
export const TEST_OPENID_MANAGER = 'TEST_E2E_L3_MANAGER_OPENID';
export const TEST_OPENID_STAFF = 'TEST_E2E_L3_STAFF_OPENID';
export const TEST_OPENID_CLIENT = 'TEST_E2E_L3_CLIENT_OPENID';

// 测试员工 / 顾客主键
export const TEST_MANAGER_EMPLOYEE_ID = 'TEST_E2E_L3_MGR_001';
export const TEST_STAFF_EMPLOYEE_ID = 'TEST_E2E_L3_STF_001';
export const TEST_CLIENT_USER_ID = 'TEST_E2E_L3_CLI_001';
export const TEST_CLIENT_PHONE = '13900000000'; // 仅测试，不要使用真实手机号格式
export const TEST_MANAGER_PHONE = '13900000001';

// 测试订单 ID 前缀（生产订单格式 FY-XSD-WX-YYMMDDNNNN，本前缀确保命名空间隔离）
export const TEST_ORDER_PREFIX = 'TEST_E2E_L3_ORD_';
export const TEST_ITEM_PREFIX = 'TEST_E2E_L3_ITM_';

// PG 连接（生产业务库 5434）
export const PG_CONN = process.env.PG_CONNECTION_STRING
  || 'postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu';

// 微信开发者工具 CLI
export const WX_CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
// IDE 自动化端口（"安全 → 服务端口" 或 IDE 自动分配的端口）
// 默认 9420（官方文档推荐值），但 IDE 可能已用其他端口；可用 WX_AUTOMATOR_PORT 环境变量覆盖。
// 检测命令：lsof -nP -iTCP -sTCP:LISTEN | grep -E 'wechat|webdev|electron' 找到实际监听端口。
export const WX_AUTOMATOR_PORT = Number(process.env.WX_AUTOMATOR_PORT || 9420);

// 小程序项目根（注意：staff/client 都把 project.config.json 放在 miniprogram/ 内）
export const STAFF_PROJECT_PATH = '/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/miniprogram';
export const CLIENT_PROJECT_PATH = '/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-client/miniprogram';

// 超时（毫秒）
export const LAUNCH_TIMEOUT_MS = 60_000;
export const PAGE_TIMEOUT_MS = 15_000;
