
const fs = require('fs');
const path = require('path');

const fontsDir = path.join(__dirname, 'fonts');
const woff2Path = path.join(fontsDir, 'vant-icon.woff2');
const woffPath = path.join(fontsDir, 'vant-icon.woff');


const woff2UrlPattern = /url\((?:https?:)?\/\/at\.alicdn\.com\/t\/c\/font_2553510_[^)]+\.woff2[^)]*\)/g;
const woffUrlPattern = /url\((?:https?:)?\/\/at\.alicdn\.com\/t\/c\/font_2553510_[^)]+\.woff[^)]*\)/g;

let fixed = 0;


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
    
  }
}

if (fixed > 0) {
  console.log(`[fix-vant-font] Patched ${fixed} file(s): CDN URL → base64 data URI`);
}
