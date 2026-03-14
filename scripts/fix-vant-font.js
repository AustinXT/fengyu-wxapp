/**
 * 修复 Vant Weapp icon 字体加载错误
 *
 * Vant Weapp 的 @font-face 使用协议相对 URL (//at.alicdn.com)，
 * 在小程序 WebView 中被解析为 http://，导致 net::ERR_CACHE_MISS。
 * 此脚本在 postinstall 阶段将其替换为 https://。
 */
const fs = require('fs');
const path = require('path');

const dirs = ['dist', 'lib'];
const target = 'url(//at.alicdn.com';
const replacement = 'url(https://at.alicdn.com';

let fixed = 0;

for (const dir of dirs) {
  const filePath = path.join('node_modules', '@vant', 'weapp', dir, 'icon', 'index.wxss');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(target)) {
      fs.writeFileSync(filePath, content.replaceAll(target, replacement));
      fixed++;
    }
  } catch (e) {
    // node_modules 可能不存在，忽略
  }
}

if (fixed > 0) {
  console.log(`[fix-vant-font] Patched ${fixed} file(s): //at.alicdn.com → https://at.alicdn.com`);
}
