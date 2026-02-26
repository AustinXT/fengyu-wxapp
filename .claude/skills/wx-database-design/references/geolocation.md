# CloudBase 地理位置查询

本文档介绍 CloudBase 中地理数据的存储与查询。

## 前置条件

查询前**必须**在地理字段上创建 `2dsphere` 索引，否则查询会报错。

## 地理数据类型

```typescript
const db = wx.cloud.database()  // 或 cloud.database()
```

### Point（坐标点）

```typescript
// 格式：经度, 纬度（注意顺序！）
const point = new db.Geo.Point(116.404, 39.915)
```

### LineString（路径）

```typescript
const line = new db.Geo.LineString([
  new db.Geo.Point(116.404, 39.915),
  new db.Geo.Point(116.405, 39.916),
  new db.Geo.Point(116.406, 39.917)
])
```

### Polygon（区域）

```typescript
// 首尾两点必须相同以闭合
const polygon = new db.Geo.Polygon([
  new db.Geo.LineString([
    new db.Geo.Point(116.404, 39.915),
    new db.Geo.Point(116.404, 39.916),
    new db.Geo.Point(116.405, 39.916),
    new db.Geo.Point(116.405, 39.915),
    new db.Geo.Point(116.404, 39.915)  // 闭合
  ])
])
```

## 存储地理数据

```typescript
await db.collection('stores').add({
  name: '朝阳店',
  location: new db.Geo.Point(116.404, 39.915),
  address: '北京市朝阳区'
})
```

## 查询操作符

### geoNear — 附近搜索

```typescript
const _ = db.command

// 查找 1000 米内的门店，按距离排序
const { data } = await db.collection('stores').where({
  location: _.geoNear({
    geometry: new db.Geo.Point(116.404, 39.915),
    maxDistance: 1000,   // 米
    minDistance: 0       // 米
  })
}).get()
```

### geoWithin — 区域搜索

```typescript
// 查找指定区域内的门店
const { data } = await db.collection('stores').where({
  location: _.geoWithin({
    geometry: searchArea  // Polygon 对象
  })
}).get()
```

### geoIntersects — 交集搜索

```typescript
// 查找与路线相交的服务区域
const { data } = await db.collection('serviceAreas').where({
  area: _.geoIntersects({
    geometry: deliveryRoute  // LineString 对象
  })
}).get()
```

## 小程序中使用

### 附近门店查找

```typescript
// pages/stores/stores.ts
Page({
  data: { stores: [] as any[] },

  async onLoad() {
    // 获取用户位置
    const location = await new Promise<WechatMiniprogram.GetLocationSuccessCallbackResult>(
      (resolve, reject) => {
        wx.getLocation({
          type: 'gcj02',
          success: resolve,
          fail: reject
        })
      }
    )

    // 查找附近门店
    const res = await wx.cloud.callFunction({
      name: 'myApi',
      data: {
        action: 'store.nearby',
        payload: {
          longitude: location.longitude,
          latitude: location.latitude,
          radius: 5000  // 5公里
        }
      }
    })
    this.setData({ stores: (res.result as any).data })
  }
})
```

### 云函数端查询

```typescript
// 云函数中执行地理查询
async function findNearbyStores(lon: number, lat: number, radius: number) {
  const _ = db.command
  const { data } = await db.collection('stores')
    .where({
      location: _.geoNear({
        geometry: new db.Geo.Point(lon, lat),
        maxDistance: radius
      })
    })
    .limit(20)
    .get()
  return data
}
```

## 常见陷阱

### 坐标顺序

```typescript
// 错误：纬度在前
new db.Geo.Point(39.915, 116.404)

// 正确：经度在前
new db.Geo.Point(116.404, 39.915)
```

### 多边形未闭合

```typescript
// 错误：首尾不同
[Point(A), Point(B), Point(C)]

// 正确：首尾相同
[Point(A), Point(B), Point(C), Point(A)]
```

### 缺少索引

地理位置查询**必须**有 `2dsphere` 索引。在 CloudBase 控制台 → 数据库 → 集合 → 索引 中创建。

## 最佳实践

1. 坐标格式 `[经度, 纬度]`，不是 `[纬度, 经度]`
2. 距离单位为米
3. 始终使用 `.limit()` 限制结果数量
4. 将地理查询与其他条件（如分类筛选）组合使用
5. 验证坐标范围：纬度 -90~90，经度 -180~180
