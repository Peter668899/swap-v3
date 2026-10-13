# Quote API 使用说明

## 概述

Quote API 用于计算代币交换的报价，支持从 PostgreSQL 数据库读取池子信息并计算输出金额。

## 数据库配置

API 会从 `../sync/config.yaml` 读取 PostgreSQL 数据库配置：

```yaml
Database:
  Host: localhost
  Port: 5432
  User: postgres
  Password: 233333@Zj
  Name: postgres
```

## 启动服务

```bash
# 使用 PostgreSQL（从配置文件读取）
go run main.go -config ../sync/config.yaml

```

## API 端点

### POST /api/v1/quote

获取交易报价。

**请求体：**
```json
{
  "tokenIn": "0x...",
  "tokenOut": "0x...",
  "amountIn": "1000000000000000000"
}
```

**响应：**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "amountOut": "950000000000000000",
    "poolAddress": "0x...",
    "success": true,
    "simulated": true
  }
}
```

## 计算逻辑

API 使用 Uniswap V3 的简化价格计算：

1. 从 PostgreSQL `pools` 表查找最佳池子（按流动性排序）
2. 使用池子的 `sqrt_price_x96` 和 `liquidity` 计算虚拟储备
3. 应用手续费（从 `fee` 字段读取，以基点为单位）
4. 使用恒定乘积公式计算输出金额

## 注意事项

- `amountIn` 应该是字符串格式的大数（wei 单位）
- `amountOut` 返回的也是字符串格式的大数
- 如果找不到交易对池子，返回 404 错误
- 如果池子没有流动性或价格为 0，返回 400 错误

