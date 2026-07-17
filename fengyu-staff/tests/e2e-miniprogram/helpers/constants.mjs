// helpers/constants.mjs — L3 E2E 测试共享常量
// 命名空间：与 L2 Agent（TEST_E2E_L2_*）严格隔离

export const NAMESPACE = 'TEST_E2E_L3_';

// 测试身份 openid（必须配合云函数环境变量 ALLOW_TEST_OPENID=true 才能生效）
export const TEST_OPENID_MANAGER = 'TEST_E2E_L3_MANAGER_OPENID';
export const TEST_OPENID_STAFF = 'TEST_E2E_L3_STAFF_OPENID';
export const TEST_OPENID_CLIENT = 'TEST_E2E_L3_CLIENT_OPENID';

// 多角色 / 多 scope openid（bs06 角色矩阵 + bs10/11/12 使用）
export const TEST_OPENID_FINANCE_STORE  = 'TEST_E2E_L3_FIN_STORE_OPENID';
export const TEST_OPENID_CUSTMGR_STORE  = 'TEST_E2E_L3_CM_STORE_OPENID';
export const TEST_OPENID_HR_STORE       = 'TEST_E2E_L3_HR_STORE_OPENID';
export const TEST_OPENID_MANAGER_MARKET = 'TEST_E2E_L3_MGR_MARKET_OPENID';
export const TEST_OPENID_MANAGER_HQ     = 'TEST_E2E_L3_MGR_HQ_OPENID';
export const TEST_OPENID_FINANCE_HQ     = 'TEST_E2E_L3_FIN_HQ_OPENID';
export const TEST_OPENID_MANAGER_A2     = 'TEST_E2E_L3_MGR_A2_OPENID'; // A 市场第二门店店长（跨店测试）
export const TEST_OPENID_MANAGER_B1     = 'TEST_E2E_L3_MGR_B1_OPENID'; // B 市场第一门店店长

// 测试员工 / 顾客主键
export const TEST_MANAGER_EMPLOYEE_ID = 'TEST_E2E_L3_MGR_001';
export const TEST_STAFF_EMPLOYEE_ID = 'TEST_E2E_L3_STF_001';
export const TEST_CLIENT_USER_ID = 'TEST_E2E_L3_CLI_001';
export const TEST_CLIENT_PHONE = '13900000000'; // 仅测试，不要使用真实手机号格式
export const TEST_MANAGER_PHONE = '13900000001';

// 多角色 employee_id
export const TEST_FIN_STORE_EMP_ID  = 'TEST_E2E_L3_FIN_STORE';
export const TEST_CM_STORE_EMP_ID   = 'TEST_E2E_L3_CM_STORE';
export const TEST_HR_STORE_EMP_ID   = 'TEST_E2E_L3_HR_STORE';
export const TEST_MGR_MARKET_EMP_ID = 'TEST_E2E_L3_MGR_MARKET';
export const TEST_MGR_HQ_EMP_ID     = 'TEST_E2E_L3_MGR_HQ';
export const TEST_FIN_HQ_EMP_ID     = 'TEST_E2E_L3_FIN_HQ';
export const TEST_MGR_A2_EMP_ID     = 'TEST_E2E_L3_MGR_A2';
export const TEST_MGR_B1_EMP_ID     = 'TEST_E2E_L3_MGR_B1';

// 测试订单 ID 前缀（生产订单格式 FY-XSD-WX-YYMMDDNNNN，本前缀确保命名空间隔离）
export const TEST_ORDER_PREFIX = 'TEST_E2E_L3_ORD_';
export const TEST_ITEM_PREFIX = 'TEST_E2E_L3_ITM_';

// 多市场 / 多门店组织 ID（bs10/11/12 用）
// 注意：默认 ensureBaseFixtures 已建 TEST_E2E_L3_HQ / _MK / _STORE / _STORE_ORG（1 市场 1 门店）
// 这里扩到 2 市场 × 2 门店：A 市场 = TEST_E2E_L3_MK + 新增 A2 门店；B 市场 + 2 门店
export const TEST_HQ_ORG_ID       = 'TEST_E2E_L3_HQ';
export const TEST_MARKET_A_ORG_ID = 'TEST_E2E_L3_MK';        // 沿用既有的"市场 A"
export const TEST_STORE_A1_ID     = 'TEST_E2E_L3_STORE';     // 沿用既有的"门店 A1"
export const TEST_STORE_A1_ORG_ID = 'TEST_E2E_L3_STORE_ORG';
export const TEST_STORE_A2_ID     = 'TEST_E2E_L3_STORE_A2';
export const TEST_STORE_A2_ORG_ID = 'TEST_E2E_L3_STORE_ORG_A2';
export const TEST_MARKET_B_ORG_ID = 'TEST_E2E_L3_MK_B';
export const TEST_STORE_B1_ID     = 'TEST_E2E_L3_STORE_B1';
export const TEST_STORE_B1_ORG_ID = 'TEST_E2E_L3_STORE_ORG_B1';

// PG 连接（生产业务库 5433）
export const PG_CONN = process.env.PG_CONNECTION_STRING
  || 'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp';

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
