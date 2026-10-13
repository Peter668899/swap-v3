# 更新池子储备工具

这个工具用于手动更新所有池子的 `reserve0` 和 `reserve1` 字段。

## 使用方法

```bash
cd sync
go run cmd/update_reserves/main.go -config config.yaml
```

## 功能说明

1. 连接到 PostgreSQL 数据库
2. 查询所有池子
3. 对每个池子调用 `token0.balanceOf(pool)` 和 `token1.balanceOf(pool)` 获取余额
4. 更新数据库中的 `reserve0` 和 `reserve1` 字段

## 注意事项

- 工具会在每个池子更新之间添加 100ms 延迟，避免 RPC 限流
- 如果某个池子更新失败，会记录错误日志但继续处理其他池子
- 建议在网络稳定时运行，确保 RPC 调用成功

## 故障排查

如果看到大量错误日志：
1. 检查 RPC 连接是否正常
2. 检查代币合约地址是否正确
3. 检查池子地址是否有效

