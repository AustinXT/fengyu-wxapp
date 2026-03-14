/**
 * 修复 Vant Weapp icon 字体加载错误
 *
 * 小程序渲染层 WebView 加载远程字体会触发 net::ERR_CACHE_MISS。
 * 此脚本在 postinstall 阶段将远程字体 URL 替换为本地 base64 data URI，
 * 彻底消除网络依赖。
 */
const fs = require('fs');
const path = require('path');

const fontsDir = path.join(__dirname, 'fonts');
const woff2Path = path.join(fontsDir, 'vant-icon.woff2');
const woffPath = path.join(fontsDir, 'vant-icon.woff');

// 远程 URL 模式（兼容 // 和 https:// 前缀）
const woff2UrlPattern = /url\((?:https?:)?\/\/at\.alicdn\.com\/t\/c\/font_2553510_[^)]+\.woff2[^)]*\)/g;
const woffUrlPattern = /url\((?:https?:)?\/\/at\.alicdn\.com\/t\/c\/font_2553510_[^)]+\.woff[^)]*\)/g;

let fixed = 0;

// 读取本地字体并转 base64
let woff2DataUri, woffDataUri;
try {
  const woff2Base64 = fs.readFileSync(woff2Path).toString('base64');
  const woffBase64 = fs.readFileSync(woffPath).toString('base64');
  woff2DataUri = `url(data:font/woff2;base64,${woff2Base64})`;
  woffDataUri = `url(data:font/woff;base64,${woffBase64})`;
} catch (e) {
  console.warn('[fix-vant-font] 字体文件未找到，跳过内联:', e.message);
  process.exit(0);
}

const dirs = ['dist', 'lib'];
for (const dir of dirs) {
  const filePath = path.join('node_modules', '@vant', 'weapp', dir, 'icon', 'index.wxss');
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    const before = content;
    content = content.replace(woff2UrlPattern, woff2DataUri);
    content = content.replace(woffUrlPattern, woffDataUri);
    if (content !== before) {
      fs.writeFileSync(filePath, content);
      fixed++;
    }
  } catch (e) {
    // node_modules 可能不存在，忽略
  }
}

if (fixed > 0) {
  console.log(`[fix-vant-font] Patched ${fixed} file(s): CDN URL → base64 data URI`);
}
