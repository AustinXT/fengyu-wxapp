// helpers/automator.mjs — miniprogram-automator 启动 / 连接封装
//
// 设计目标：
// - launch() 通过 CLI 启动 IDE 并加载项目；若 IDE 已运行则自动复用现有会话
// - 提供 staff / client 两个项目的便捷入口
// - 启动前主动检测 IDE 安全端口（默认 9420），未开启给出明确指引而非长超时
// - 处理 IDE 启动慢的情况，加大默认 timeout

import http from 'node:http';
import { execSync } from 'node:child_process';
import automator from 'miniprogram-automator';
import {
  WX_CLI_PATH,
  WX_AUTOMATOR_PORT,
  STAFF_PROJECT_PATH,
  CLIENT_PROJECT_PATH,
  LAUNCH_TIMEOUT_MS,
} from './constants.mjs';

/**
 * 扫描 IDE 进程当前监听的所有本地 TCP 端口，找出 HTTP 可用的那个。
 *
 * 背景：微信开发者工具启动后会暴露 automator HTTP server，端口可能是
 *   - 用户在"安全 → 服务端口"指定的 9420
 *   - 或 IDE 自动分配的随机端口（启动时 CLI 报告 "IDE server has started on http://127.0.0.1:NNNN"）
 *
 * 优先返回 WX_AUTOMATOR_PORT，找不到才扫描。
 */
export async function discoverIdePort() {
  // 1. 优先指定端口
  if (await isPortAlive(WX_AUTOMATOR_PORT)) return WX_AUTOMATOR_PORT;

  // 2. 扫 IDE 进程监听的所有端口
  let candidates = [];
  try {
    const out = execSync(
      "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -iE 'wechatweb|webdevtools' || true",
      { encoding: 'utf8' },
    );
    candidates = [...out.matchAll(/127\.0\.0\.1:(\d+)/g)].map(m => Number(m[1]));
    candidates = [...new Set(candidates)];
  } catch (e) {
    // ignore — 没有 lsof / 没匹配
  }

  // 3. 探活：HTTP HEAD 通的就是 automator HTTP server
  for (const port of candidates) {
    if (await isPortAlive(port, 800)) return port;
  }
  return null;
}

function isPortAlive(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * 检测微信开发者工具 "安全 → 服务端口" 是否已开启。
 * IDE 开了端口后，curl http://127.0.0.1:9420 会返回 200/404 之类，
 * 连接被拒（ECONNREFUSED）则表示未开。
 *
 * @returns {Promise<boolean>}
 */
export function isAutomatorPortOpen(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port: WX_AUTOMATOR_PORT,
      path: '/',
      timeout: timeoutMs,
    }, (res) => {
      // 任何 HTTP 响应都意味着端口已开
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * 详细检查并打印诊断信息（自动化失败的 80% 原因都在这里）。
 * 失败时抛出带有可操作指引的 Error。
 *
 * @returns {Promise<number>} 探活成功的端口号
 */
export async function ensureIdeReady() {
  // 先用指定端口探活；不通则扫描 IDE 进程在监听的全部端口
  if (await isAutomatorPortOpen()) return WX_AUTOMATOR_PORT;

  const port = await discoverIdePort();
  if (port) {
    // 找到一个能用的，但不是配置默认值 — 提醒用户用环境变量锁定
    if (port !== WX_AUTOMATOR_PORT) {
      console.warn(
        `[L3 E2E] 自动发现 IDE 自动化端口 = ${port}（默认 ${WX_AUTOMATOR_PORT} 不通）。\n` +
        `         建议下次运行加 env：WX_AUTOMATOR_PORT=${port}  bun tests/e2e-miniprogram/...\n` +
        `         或在 "设置 → 安全 → 服务端口" 把端口固定为 ${WX_AUTOMATOR_PORT}。`,
      );
    }
    return port;
  }

  throw new Error(
    [
      '',
      '[L3 E2E] 微信开发者工具自动化端口未开启（默认 127.0.0.1:' + WX_AUTOMATOR_PORT + '）。',
      '',
      '一次性配置步骤（任选其一）：',
      '  方式 A — 固定端口 9420（推荐）：',
      '    1. 打开微信开发者工具',
      '    2. 顶部菜单：设置 → 安全 → 服务端口',
      '    3. 勾选 "服务端口"，端口号填 9420',
      '    4. 重启微信开发者工具一次',
      '    5. 验证：curl http://127.0.0.1:9420  → 返回 HTTP 响应',
      '',
      '  方式 B — 让 IDE 自动分配端口（启动 IDE 后由测试自动发现）：',
      '    1. 打开微信开发者工具，加载小程序项目（任意 fengyu-staff 或 fengyu-client）',
      '    2. 直接跑测试，本 helper 会扫描 IDE 进程监听端口',
      '    3. 找到后控制台会提示推荐的 WX_AUTOMATOR_PORT 值，下次加到 env 锁定即可',
      '',
    ].join('\n')
  );
}

/**
 * 启动 / 连接到指定项目的小程序自动化会话。
 *
 * automator.launch() 行为：
 * - 若 IDE 未启动，会通过 cliPath 启动并加载 projectPath
 * - 若 IDE 已启动且加载了项目，会复用现有窗口
 *
 * @param {string} projectPath 小程序项目根（含 project.config.json）
 * @returns {Promise<import('miniprogram-automator').MiniProgram>}
 */
/**
 * 默认走 **connect** 模式：假设 IDE 已经开着对应项目 + automator 端口已暴露。
 * 这是最稳的姿势，因为 launch() 会尝试再 spawn 一个 IDE 实例，端口冲突时直接报错。
 *
 * 仅在端口完全没开、需要从零拉起 IDE 时退化到 launch()。
 */
export async function launch(projectPath) {
  const port = await ensureIdeReady();

  // 路径一：connect 已运行的 IDE
  try {
    const wsEndpoint = `ws://127.0.0.1:${port}`;
    const mp = await automator.connect({ wsEndpoint });
    return mp;
  } catch (e) {
    // connect 失败说明端口虽然 HTTP 通了但不是 automator 协议端口（不是 ws 入口）
    // 此时退化到 launch（让 launcher 自己 spawn 一个新的 auto session）
    console.warn(`[L3 E2E] connect(${port}) 失败：${e.message}；退化到 launch 模式`);
  }

  // 路径二：launch（让 launcher spawn cli auto --auto-port）
  const launchPromise = automator.launch({
    cliPath: WX_CLI_PATH,
    projectPath,
    // 不指定 port —— 让 launcher 自动选一个空闲端口（getPort 起点 9420）
    timeout: LAUNCH_TIMEOUT_MS,
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(
      `[L3 E2E] automator.launch 超时（${LAUNCH_TIMEOUT_MS}ms）。\n` +
      `项目路径: ${projectPath}\n` +
      `常见原因：\n` +
      `  - IDE 加载小程序很慢（首次编译/未构建 npm）；可先在 IDE 中手动打开项目并构建 npm\n` +
      `  - IDE 当前窗口已加载其他项目；先在 IDE 中切换到此项目再重试\n`
    )), LAUNCH_TIMEOUT_MS + 5000);
  });

  return Promise.race([launchPromise, timeoutPromise]);
}

export function launchStaff() {
  return launch(STAFF_PROJECT_PATH);
}

export function launchClient() {
  return launch(CLIENT_PROJECT_PATH);
}

/**
 * 安全关闭：automator.close() 在某些版本会一并关闭 IDE，
 * 为保留 IDE 给下次跑用，调用 disconnect() 即可。
 */
export async function disconnect(miniProgram) {
  if (!miniProgram) return;
  try {
    // 优先 disconnect（保留 IDE 进程），不存在时 fallback 到 close
    if (typeof miniProgram.disconnect === 'function') {
      await miniProgram.disconnect();
    } else if (typeof miniProgram.close === 'function') {
      await miniProgram.close();
    }
  } catch (e) {
    console.warn('[L3 E2E] disconnect 警告（可忽略）:', e.message);
  }
}
