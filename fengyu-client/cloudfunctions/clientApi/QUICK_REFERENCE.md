# clientApi 云函数快速参考

## 接口速查表

### 认证
```javascript
// 登录
wx.cloud.callFunction({
  name: 'clientApi',
  data: { action: 'auth.login', payload: {} }
})

// 绑定手机号
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'auth.bindPhone',
    payload: { phoneNumber: '13800138000' }
  }
})
```

### 门店
```javascript
// 门店列表
wx.cloud.callFunction({
  name: 'clientApi',
  data: { action: 'store.list', payload: {} }
})
```

### 商品
```javascript
// 品项分类
wx.cloud.callFunction({
  name: 'clientApi',
  data: { action: 'product.categories', payload: {} }
})

// SPU 列表
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'product.spuList',
    payload: { category: '蜜语生玑' }
  }
})

// SKU 详情
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'product.skuDetail',
    payload: { skuId: 'sku_xxx' }
  }
})
```

### 美容师
```javascript
// 美容师列表
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'staff.list',
    payload: { storeName: '昭通团结店' }
  }
})
```

### 订单
```javascript
// 下单
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'order.create',
    payload: {
      storeName: '昭通团结店',
      marketName: '昭通市场',
      items: [
        { skuId: 'sku_xxx', quantity: 1 }
      ],
      paymentMethod: 'wechat',
      preferredStaffWfId: 'FY-200101001' // 可选
    }
  }
})

// 微信支付
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'order.pay',
    payload: { orderNo: 'FY-XSD-WX-2601010001' }
  }
})

// 线下付款
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'order.offlinePay',
    payload: { orderNo: 'FY-XSD-WX-2601010001' }
  }
})

// 订单列表
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'order.list',
    payload: { status: '已支付' }
  }
})

// 订单详情
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'order.detail',
    payload: { orderNo: 'FY-XSD-WX-2601010001' }
  }
})
```

### 预约
```javascript
// 发起预约
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'appointment.create',
    payload: {
      itemFlowNo: 'XSLSH-WX-202601010001',
      appointmentTime: '2026-01-05 14:00:00',
      staffWfId: 'FY-200101001', // 可选
      notes: '备注'
    }
  }
})

// 预约列表
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'appointment.list',
    payload: { status: '待确认' }
  }
})

// 取消预约
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'appointment.cancel',
    payload: {
      appointmentId: 'apt_xxx',
      cancelledReason: '临时有事'
    }
  }
})
```

### 服务单
```javascript
// 服务单详情
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'service.detail',
    payload: { serviceOrderNo: 'HLD-WX-2601010001' }
  }
})
```

## 响应格式

### 成功
```javascript
{
  code: 0,
  message: 'success',
  data: { ... }
}
```

### 失败
```javascript
{
  code: -1,        // 错误码
  message: '错误信息',
  data: null
}
```

## 错误码

| code | 说明 |
|------|------|
| 0 | 成功 |
| -1 | 通用错误 |
| -400 | 参数错误 |
| -401 | 未授权(未登录) |
| -403 | 权限不足(未绑定手机号等) |

## 环境变量

```bash
# PG 数据库
PG_CONNECTION_STRING=postgresql://...

# WorkFine SQL Server
MSSQL_SERVER=111.229.31.128
MSSQL_PORT=1433
MSSQL_USER=Sa
MSSQL_PASSWORD=oHx#+Q
MSSQL_DATABASE=wkdb_20220804_86cd3292
```

## 数据库表

### PG 自托管
- `client_wechat_users` - 微信用户
- `product_spu` - SPU 商品
- `product_spu_sku_map` - SKU 映射
- `orders` - 订单主表
- `order_items` - 订单明细
- `appointments` - 预约
- `service_orders` - 服务单主表
- `service_items` - 服务单明细

### WorkFine 只读
- `UDT_M_219` - 门店列表
- `UDT_S_287` - 人事档案
- `UDT_M_1281` - 可售项目(全国)
- `UDT_M_1383` - 门店自定义项目
- `UDT_M_341` - 院装产品

## 常见问题

### 1. 未登录
```
错误: UNAUTHORIZED: 无法获取用户身份
解决: 确保小程序已调用 wx.cloud.init()
```

### 2. 未绑定手机号
```
错误: PHONE_REQUIRED: 请先绑定手机号
解决: 先调用 auth.bindPhone
```

### 3. 订单不存在
```
错误: INVALID_PARAMS: 订单不存在
解决: 检查 orderNo 是否正确,检查是否为当前用户的订单
```

### 4. 剩余次数不足
```
错误: INVALID_PARAMS: 剩余次数不足
解决: 检查 order_items.remaining_sessions
```

### 5. 已有待支付订单
```
错误: INVALID_PARAMS: 您已有待支付订单
解决: 先完成或取消现有待支付订单
```

## 开发调试

### 查看日志
```bash
# CloudBase 控制台
云函数 → clientApi → 日志
```

### 本地测试
```bash
# 安装依赖
cd fengyu-client/cloudfunctions/clientApi
npm install

# 本地运行(需要配置 cloudbaserc.js)
tcb fn run --name clientApi
```

## 性能优化

1. **连接池**: pg.js 已配置连接池,冷启动优化
2. **索引**: 为常用查询字段添加索引
3. **WorkFine 查询**: 只查询必要字段
4. **分页**: 大列表使用分页查询

## 下一步

- [ ] 部署到 CloudBase 环境
- [ ] 开发 payNotify 云函数
- [ ] 开发员工端 staffApi
- [ ] 实现实时推送
- [ ] 端到端测试
