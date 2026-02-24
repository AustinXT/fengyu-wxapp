# CloudBase 地理位置查询

本文档介绍如何在 CloudBase 中处理地理数据和执行基于位置的查询。

## 前置条件

**注意（重要）**：在执行任何地理位置查询之前，你**必须**在要查询的字段上创建地理位置索引。没有正确的索引，查询将会失败。

## 地理数据类型

CloudBase 通过 `db.Geo` 支持多种地理数据类型：

```javascript
const db = app.database();
```

### Point（单个位置）

表示单个地理坐标：

```javascript
// 创建一个 Point：经度, 纬度
const point = new db.Geo.Point(116.404, 39.915);  // 天安门广场坐标
```

**注意：** 坐标格式为 `[经度, 纬度]`（不是纬度, 经度）。

### LineString（路径/路线）

表示一条路径或路线：

```javascript
// 创建一个 LineString（Point 数组）
const line = new db.Geo.LineString([
    new db.Geo.Point(116.404, 39.915),  // 起点
    new db.Geo.Point(116.405, 39.916),  // 途经点
    new db.Geo.Point(116.406, 39.917)   // 终点
]);
```

### Polygon（区域）

表示一个封闭区域：

```javascript
// 创建一个 Polygon（LineString 数组，第一个为外边界）
const polygon = new db.Geo.Polygon([
    new db.Geo.LineString([
        new db.Geo.Point(116.404, 39.915),
        new db.Geo.Point(116.404, 39.916),
        new db.Geo.Point(116.405, 39.916),
        new db.Geo.Point(116.405, 39.915),
        new db.Geo.Point(116.404, 39.915)   // 必须闭合多边形
    ])
]);
```

**注意：** 首尾两个点必须相同以闭合多边形。

## 存储地理数据

在文档中存储位置数据：

```javascript
// 添加一个带位置信息的用户
await db.collection('users').add({
    name: 'John',
    location: new db.Geo.Point(116.404, 39.915),
    address: 'Beijing, China'
});

// 添加一条配送路线
await db.collection('routes').add({
    name: 'Route A',
    path: new db.Geo.LineString([
        new db.Geo.Point(116.404, 39.915),
        new db.Geo.Point(116.405, 39.916),
        new db.Geo.Point(116.406, 39.917)
    ])
});

// 添加一个服务区域
await db.collection('serviceAreas').add({
    name: 'Downtown',
    area: new db.Geo.Polygon([
        new db.Geo.LineString([
            new db.Geo.Point(116.404, 39.915),
            new db.Geo.Point(116.404, 39.916),
            new db.Geo.Point(116.405, 39.916),
            new db.Geo.Point(116.405, 39.915),
            new db.Geo.Point(116.404, 39.915)
        ])
    ])
});
```

## 地理位置查询操作符

CloudBase 提供三个主要的地理位置查询操作符：

### 1. geoNear（附近搜索）

查找指定位置附近的文档，按距离排序：

```javascript
const _ = db.command;

// 查找某位置 1000 米内的用户
const result = await db.collection('users').where({
    location: _.geoNear({
        geometry: new db.Geo.Point(116.404, 39.915),  // 中心点
        maxDistance: 1000,   // 最大距离，单位为米
        minDistance: 0       // 最小距离，单位为米
    })
}).get();

console.log('Nearby users:', result.data);
```

**参数：**
- `geometry` - 中心点（Point 对象）
- `maxDistance` - 最大距离，单位为米（可选）
- `minDistance` - 最小距离，单位为米（可选，默认值：0）

**重要：** 结果会自动按距离排序（最近的排在前面）。

### 2. geoWithin（区域搜索）

查找特定地理区域内的文档：

```javascript
const _ = db.command;

// 定义搜索区域
const searchArea = new db.Geo.Polygon([
    new db.Geo.LineString([
        new db.Geo.Point(116.404, 39.915),
        new db.Geo.Point(116.404, 39.920),
        new db.Geo.Point(116.410, 39.920),
        new db.Geo.Point(116.410, 39.915),
        new db.Geo.Point(116.404, 39.915)
    ])
]);

// 查找该区域内的用户
const result = await db.collection('users').where({
    location: _.geoWithin({
        geometry: searchArea
    })
}).get();
```

**使用场景：**
- 查找某个街区内的所有商店
- 城市边界内的用户
- 服务区域内的配送订单

### 3. geoIntersects（交集搜索）

查找与指定几何图形相交的文档：

```javascript
const _ = db.command;

// 定义一条路径/路线
const deliveryRoute = new db.Geo.LineString([
    new db.Geo.Point(116.404, 39.915),
    new db.Geo.Point(116.410, 39.920)
]);

// 查找与该路线相交的服务区域
const result = await db.collection('serviceAreas').where({
    area: _.geoIntersects({
        geometry: deliveryRoute
    })
}).get();
```

**使用场景：**
- 穿越服务区域的路线
- 重叠的地理区域
- 路径规划

## 完整示例

### 附近搜索应用

```javascript
async function findNearbyPlaces(userLat, userLon, radius = 5000, category = null) {
    const _ = db.command;
    const userLocation = new db.Geo.Point(userLon, userLat);

    let whereCondition = {
        location: _.geoNear({
            geometry: userLocation,
            maxDistance: radius
        })
    };

    // 如果指定了分类则添加分类筛选
    if (category) {
        whereCondition.category = category;
    }

    try {
        const result = await db.collection('places')
            .where(whereCondition)
            .limit(20)
            .get();

        return result.data;
    } catch (error) {
        console.error('Nearby search failed:', error);
        throw error;
    }
}

// 使用方法
const nearbyRestaurants = await findNearbyPlaces(39.915, 116.404, 2000, 'restaurant');
console.log('Found', nearbyRestaurants.length, 'restaurants nearby');
```

### 配送区域检查器

```javascript
async function isInDeliveryZone(userLat, userLon, storeId) {
    const _ = db.command;
    const userLocation = new db.Geo.Point(userLon, userLat);

    try {
        // 获取商店的配送区域
        const store = await db.collection('stores')
            .doc(storeId)
            .get();

        if (!store.data || !store.data.deliveryZone) {
            return false;
        }

        // 检查用户位置是否在配送区域内
        const result = await db.collection('stores')
            .where({
                _id: storeId,
                deliveryZone: _.geoWithin({
                    geometry: new db.Geo.Point(userLon, userLat)
                })
            })
            .get();

        return result.data.length > 0;
    } catch (error) {
        console.error('Zone check failed:', error);
        return false;
    }
}

// 使用方法
const canDeliver = await isInDeliveryZone(39.915, 116.404, 'store-123');
console.log('Can deliver:', canDeliver);
```

### 基于距离的定价

```javascript
async function calculateDeliveryFee(userLat, userLon, storeId) {
    const _ = db.command;

    try {
        // 获取商店位置
        const store = await db.collection('stores')
            .doc(storeId)
            .get();

        if (!store.data || !store.data.location) {
            throw new Error('Store location not found');
        }

        const userLocation = new db.Geo.Point(userLon, userLat);

        // 查找带距离信息的商店
        const result = await db.collection('stores')
            .where({
                _id: storeId,
                location: _.geoNear({
                    geometry: userLocation,
                    maxDistance: 20000  // 最大 20 公里
                })
            })
            .get();

        if (result.data.length === 0) {
            throw new Error('Location outside delivery range');
        }

        // 基于距离计算配送费
        // 注意：CloudBase 会在结果中返回距离信息
        const distance = result.data[0].distance || 0;
        const baseFee = 5;
        const perKmFee = 2;
        const deliveryFee = baseFee + (distance / 1000) * perKmFee;

        return {
            distance: Math.round(distance),
            fee: Math.round(deliveryFee * 100) / 100
        };
    } catch (error) {
        console.error('Fee calculation failed:', error);
        throw error;
    }
}

// 使用方法
const delivery = await calculateDeliveryFee(39.915, 116.404, 'store-123');
console.log(`Distance: ${delivery.distance}m, Fee: $${delivery.fee}`);
```

## 创建地理位置索引

**查询前必须完成此步骤！**

你需要通过 CloudBase 控制台创建索引：

1. 进入 CloudBase 控制台
2. 导航到 数据库 -> 你的集合
3. 进入 索引 标签页
4. 创建新索引：
   - 字段：`location`（或你的地理字段名）
   - 类型：`geo` 或 `2dsphere`

没有此索引，地理位置查询将会报错失败。

## 最佳实践

1. **始终创建索引**：地理位置查询需要正确的索引
2. **坐标顺序**：使用 [经度, 纬度]，而非 [纬度, 经度]
3. **闭合多边形**：多边形的首尾两个点必须相同
4. **距离单位**：所有距离单位均为米
5. **限制结果数量**：对大数据集使用 `.limit()`
6. **错误处理**：始终将地理查询包裹在 try-catch 中
7. **验证坐标**：确保纬度在 -90 到 90 之间，经度在 -180 到 180 之间
8. **组合筛选条件**：在需要时将地理查询与其他条件混合使用

## 常见陷阱

### 坐标顺序错误
```javascript
// 错误 - 纬度在前
new db.Geo.Point(39.915, 116.404)

// 正确 - 经度在前
new db.Geo.Point(116.404, 39.915)
```

### 多边形未闭合
```javascript
// 错误 - 未闭合
new db.Geo.LineString([
    new db.Geo.Point(116.404, 39.915),
    new db.Geo.Point(116.405, 39.916),
    new db.Geo.Point(116.405, 39.915)
])

// 正确 - 首尾相同
new db.Geo.LineString([
    new db.Geo.Point(116.404, 39.915),
    new db.Geo.Point(116.405, 39.916),
    new db.Geo.Point(116.405, 39.915),
    new db.Geo.Point(116.404, 39.915)  // 闭合多边形
])
```

### 缺少索引
```javascript
// 错误 - 没有地理索引将会失败
await db.collection('users').where({
    location: _.geoNear({ geometry: point })
}).get()

// 正确 - 先在控制台创建索引，再进行查询
```

## 性能注意事项

1. **索引大小**：地理位置索引可能较大，需监控存储空间
2. **查询半径**：较小半径的查询速度更快
3. **结果限制**：始终使用 `.limit()` 以避免返回过大的结果集
4. **组合条件**：先按分类/类型筛选，再按位置筛选
5. **缓存结果**：缓存频繁访问的位置数据

## React 示例组件

```javascript
import { useState, useEffect } from 'react';

function NearbyPlaces({ userLat, userLon }) {
    const [places, setPlaces] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadNearbyPlaces();
    }, [userLat, userLon]);

    async function loadNearbyPlaces() {
        setLoading(true);
        try {
            const _ = db.command;
            const result = await db.collection('places')
                .where({
                    location: _.geoNear({
                        geometry: new db.Geo.Point(userLon, userLat),
                        maxDistance: 5000
                    })
                })
                .limit(10)
                .get();

            setPlaces(result.data);
        } catch (error) {
            console.error('Failed to load places:', error);
        } finally {
            setLoading(false);
        }
    }

    if (loading) return <div>正在加载附近地点...</div>;

    return (
        <div>
            <h2>附近地点</h2>
            <ul>
                {places.map(place => (
                    <li key={place._id}>
                        {place.name} - 距离 {Math.round(place.distance)} 米
                    </li>
                ))}
            </ul>
        </div>
    );
}
```
