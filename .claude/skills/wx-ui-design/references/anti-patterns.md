# 反模式与交付清单

小程序 UI 开发中必须避免的典型问题与代码提交前的自检清单。

主文件：[SKILL.md](../SKILL.md)

---

## 反模式速查

### 样式反模式

```css
/* ❌ 布局尺寸使用 px 单位 */
.box { width: 375px; padding: 16px; font-size: 14px; }
/* ✅ 使用 rpx */
.box { width: 750rpx; padding: 32rpx; font-size: 28rpx; }

/* ✅ 允许：细边框使用 px */
.divider { border-bottom: 1px solid #e8e8e8; }

/* ❌ AI 模板紫色渐变 */
.banner { background: linear-gradient(135deg, #7C3AED, #EC4899); }
/* ✅ 品牌色渐变 */
.banner { background: linear-gradient(135deg, #D4A574, #C97B5A); }

/* ❌ 所有页面一模一样的白卡片 */
.page-a .card,
.page-b .card,
.page-c .card { background: #fff; border-radius: 16rpx; box-shadow: 0 4rpx 12rpx rgba(0,0,0,0.08); }
/* ✅ 根据页面角色调整视觉节奏 */
.detail-hero { background: linear-gradient(180deg, #FFF8F0, transparent); padding: 48rpx 32rpx; }
.info-row { border-bottom: 1rpx solid var(--color-border); padding: 24rpx 0; }
```

### 标签反模式

```xml
<!-- ❌ 使用 HTML 标签 -->
<div class="container"><span>文字</span></div>
<!-- ✅ 使用原生组件 -->
<view class="container"><text>文字</text></view>

<!-- ❌ Emoji 当图标 -->
<text>首页</text>
<text>收藏</text>
<!-- ✅ 本地图片图标 -->
<image src="/images/icon-home.png" class="icon" />
<image src="/images/icon-star.png" class="icon" />
```

---

## 交付质量清单

生成代码前必须自检：

### 原生规范

- [ ] 是否使用了 `<div>` 或 `<span>`？ --> 替换为 `<view>` / `<text>`
- [ ] 样式单位是否优先使用 `rpx`？（border 场景可用 `1px`）
- [ ] Page 对象中是否包含 `onShareAppMessage`？（项目约定）
- [ ] JSON 配置是否包含 `navigationBarTitleText`？（项目约定，官方可选）
- [ ] 代码是否为 Native 写法而非 React/Vue 写法？

### 设计规范

- [ ] 是否在编码前输出了设计规范？
- [ ] 配色是否避开了禁用颜色（紫色系/蓝紫渐变）？
- [ ] 页面是否有清晰的视觉层次和节奏感？
- [ ] 不同页面之间是否有统一的品牌调性？

### 资源完整性

- [ ] 引用的图标资源是否已下载到本地？
- [ ] 图标风格是否全局统一（同一 style）？
- [ ] 是否使用了 emoji 字符当图标？ --> 替换为本地图片

如果任何检查失败 --> 修正后再提交
