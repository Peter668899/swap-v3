package api

import (
	"database/sql"
	"fmt"
	"math/big"
	"strings"

	_ "github.com/lib/pq"
	_ "github.com/mattn/go-sqlite3"
)

// DexBot DEX 机器人
type DexBot struct {
	db         *sql.DB
	dbType     string // "postgres" 或 "sqlite3"
}

// NewDexBot 创建新的 DexBot 实例（SQLite）
func NewDexBot(dbPath string) (*DexBot, error) {
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("连接数据库失败: %w", err)
	}

	return &DexBot{db: db, dbType: "sqlite3"}, nil
}

// NewDexBotFromPostgres 从 PostgreSQL 连接创建新的 DexBot 实例
func NewDexBotFromPostgres(host string, port int, user, password, dbname string) (*DexBot, error) {
	// 判断是否需要 SSL（本地数据库通常不需要）
	sslMode := "require"
	if host == "localhost" || host == "127.0.0.1" {
		sslMode = "disable"
	}

	connStr := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		host, port, user, password, dbname, sslMode)

	db, err := sql.Open("postgres", connStr)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("连接数据库失败: %w", err)
	}

	return &DexBot{db: db, dbType: "postgres"}, nil
}

// InitDB 初始化数据库表
func (bot *DexBot) InitDB() error {
	schema := `
	CREATE TABLE IF NOT EXISTS token_liquidity_pools (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		pool_address TEXT NOT NULL,
		dex_name TEXT NOT NULL,
		dex_router TEXT NOT NULL,
		chain_id INTEGER NOT NULL,
		token0_address TEXT NOT NULL,
		token0_symbol TEXT,
		token0_decimals INTEGER,
		token1_address TEXT NOT NULL,
		token1_symbol TEXT,
		token1_decimals INTEGER,
		reserve0 TEXT,
		reserve1 TEXT,
		liquidity_usd REAL,
		fee_rate REAL DEFAULT 0.003,
		volume_24h REAL,
		is_active BOOLEAN DEFAULT 1,
		last_updated INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		UNIQUE(pool_address, chain_id)
	);
	
	CREATE INDEX IF NOT EXISTS idx_token0_chain ON token_liquidity_pools(token0_address, chain_id);
	CREATE INDEX IF NOT EXISTS idx_token1_chain ON token_liquidity_pools(token1_address, chain_id);
	CREATE INDEX IF NOT EXISTS idx_token0_token1_chain ON token_liquidity_pools(token0_address, token1_address, chain_id);
	CREATE INDEX IF NOT EXISTS idx_liquidity ON token_liquidity_pools(chain_id, liquidity_usd DESC) WHERE is_active = 1;
	`

	_, err := bot.db.Exec(schema)
	return err
}

// ListPools 获取流动性池列表
func (bot *DexBot) ListPools(chainID, dexName string, limit int) ([]Pool, error) {
	// 如果使用 PostgreSQL，查询 pools 表
	if bot.dbType == "postgres" {
		return bot.listPoolsFromPostgres(limit)
	}

	// SQLite 查询（使用 ? 占位符）
	query := `
		SELECT 
			id, pool_address, dex_name, dex_router, chain_id,
			token0_address, token0_symbol, token1_address, token1_symbol,
			reserve0, reserve1, liquidity_usd, fee_rate, is_active
		FROM token_liquidity_pools
		WHERE 1=1
	`
	args := []interface{}{}

	if chainID != "" {
		query += " AND chain_id = ?"
		args = append(args, chainID)
	}

	if dexName != "" {
		query += " AND dex_name = ?"
		args = append(args, dexName)
	}

	query += " ORDER BY liquidity_usd DESC LIMIT ?"
	args = append(args, limit)

	rows, err := bot.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pools []Pool
	for rows.Next() {
		var pool Pool
		err := rows.Scan(
			&pool.ID, &pool.PoolAddress, &pool.DexName, &pool.DexRouter, &pool.ChainID,
			&pool.Token0Address, &pool.Token0Symbol, &pool.Token1Address, &pool.Token1Symbol,
			&pool.Reserve0, &pool.Reserve1, &pool.LiquidityUSD, &pool.FeeRate, &pool.IsActive,
		)
		if err != nil {
			return nil, err
		}
		pools = append(pools, pool)
	}

	return pools, nil
}

// listPoolsFromPostgres 从 PostgreSQL pools 表查询池子列表
func (bot *DexBot) listPoolsFromPostgres(limit int) ([]Pool, error) {
	query := `
		SELECT 
			address, token0, token1, fee, liquidity, sqrt_price_x96, tick, reserve0, reserve1
		FROM pools
		ORDER BY liquidity DESC
		LIMIT $1
	`

	rows, err := bot.db.Query(query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pools []Pool
	poolID := 1
	for rows.Next() {
		var pool Pool
		var address, token0, token1 string
		var fee int64
		var liquidity sql.NullString // 使用 NullString 处理可能为 NULL 的值
		var sqrtPriceX96 sql.NullString
		var tick sql.NullInt64
		var reserve0 sql.NullString
		var reserve1 sql.NullString

		err := rows.Scan(&address, &token0, &token1, &fee, &liquidity, &sqrtPriceX96, &tick, &reserve0, &reserve1)
		if err != nil {
			return nil, err
		}

		// 转换为 Pool 结构
		pool.ID = poolID
		pool.PoolAddress = address
		pool.DexName = "MetaNodeSwap"
		pool.DexRouter = ""
		pool.ChainID = 31337 // 默认本地链，可以根据需要调整
		pool.Token0Address = token0
		pool.Token0Symbol = ""
		pool.Token1Address = token1
		pool.Token1Symbol = ""
		
		// 使用数据库中的 reserve0 和 reserve1
		if reserve0.Valid {
			pool.Reserve0 = reserve0.String
		} else {
			pool.Reserve0 = "0"
		}
		if reserve1.Valid {
			pool.Reserve1 = reserve1.String
		} else {
			pool.Reserve1 = "0"
		}
		
		// 将 liquidity 从 NUMERIC 转换为 float64
		var liquidityFloat float64
		if liquidity.Valid && liquidity.String != "" {
			_, err := fmt.Sscanf(liquidity.String, "%f", &liquidityFloat)
			if err != nil {
				liquidityFloat = 0
			}
		}
		pool.LiquidityUSD = liquidityFloat
		
		// fee 是基点，转换为费率（例如 3000 = 0.003）
		pool.FeeRate = float64(fee) / 1000000.0
		pool.IsActive = true

		pools = append(pools, pool)
		poolID++
	}

	return pools, nil
}

// GetPoolByAddress 根据地址获取池子
func (bot *DexBot) GetPoolByAddress(poolAddress string, chainID int) (*Pool, error) {
	// 如果使用 PostgreSQL，查询 pools 表
	if bot.dbType == "postgres" {
		return bot.getPoolByAddressFromPostgres(poolAddress)
	}

	// SQLite 查询
	query := `
		SELECT 
			id, pool_address, dex_name, dex_router, chain_id,
			token0_address, token0_symbol, token1_address, token1_symbol,
			reserve0, reserve1, liquidity_usd, fee_rate, is_active
		FROM token_liquidity_pools
		WHERE pool_address = ? AND chain_id = ?
	`

	var pool Pool
	err := bot.db.QueryRow(query, poolAddress, chainID).Scan(
		&pool.ID, &pool.PoolAddress, &pool.DexName, &pool.DexRouter, &pool.ChainID,
		&pool.Token0Address, &pool.Token0Symbol, &pool.Token1Address, &pool.Token1Symbol,
		&pool.Reserve0, &pool.Reserve1, &pool.LiquidityUSD, &pool.FeeRate, &pool.IsActive,
	)

	if err != nil {
		return nil, err
	}

	return &pool, nil
}

// getPoolByAddressFromPostgres 从 PostgreSQL pools 表查询池子
func (bot *DexBot) getPoolByAddressFromPostgres(poolAddress string) (*Pool, error) {
	query := `
		SELECT 
			address, token0, token1, fee, liquidity, sqrt_price_x96, tick, reserve0, reserve1
		FROM pools
		WHERE address = $1
	`

	var pool Pool
	var address, token0, token1 string
	var fee int64
	var liquidity sql.NullString
	var sqrtPriceX96 sql.NullString
	var tick sql.NullInt64
	var reserve0 sql.NullString
	var reserve1 sql.NullString

	err := bot.db.QueryRow(query, poolAddress).Scan(
		&address, &token0, &token1, &fee, &liquidity, &sqrtPriceX96, &tick, &reserve0, &reserve1,
	)
	if err != nil {
		return nil, err
	}

	// 转换为 Pool 结构
	pool.ID = 1
	pool.PoolAddress = address
	pool.DexName = "MetaNodeSwap"
	pool.DexRouter = ""
	pool.ChainID = 31337 // 默认本地链
	pool.Token0Address = token0
	pool.Token0Symbol = ""
	pool.Token1Address = token1
	pool.Token1Symbol = ""
	
	// 使用数据库中的 reserve0 和 reserve1
	if reserve0.Valid {
		pool.Reserve0 = reserve0.String
	} else {
		pool.Reserve0 = "0"
	}
	if reserve1.Valid {
		pool.Reserve1 = reserve1.String
	} else {
		pool.Reserve1 = "0"
	}

	// 转换 liquidity
	var liquidityFloat float64
	if liquidity.Valid && liquidity.String != "" {
		_, err := fmt.Sscanf(liquidity.String, "%f", &liquidityFloat)
		if err != nil {
			liquidityFloat = 0
		}
	}
	pool.LiquidityUSD = liquidityFloat

	// fee 是基点，转换为费率
	pool.FeeRate = float64(fee) / 1000000.0
	pool.IsActive = true

	return &pool, nil
}

// FindDirectRoute 查找直接交易路由
func (bot *DexBot) FindDirectRoute(chainID int, tokenIn, tokenOut string) ([]Pool, error) {
	query := `
		SELECT 
			id, pool_address, dex_name, dex_router, chain_id,
			token0_address, token0_symbol, token1_address, token1_symbol,
			reserve0, reserve1, liquidity_usd, fee_rate, is_active
		FROM token_liquidity_pools
		WHERE chain_id = ? 
			AND is_active = 1
			AND (
				(token0_address = ? AND token1_address = ?)
				OR (token0_address = ? AND token1_address = ?)
			)
		ORDER BY liquidity_usd DESC
		LIMIT 10
	`

	rows, err := bot.db.Query(query, chainID, tokenIn, tokenOut, tokenOut, tokenIn)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pools []Pool
	for rows.Next() {
		var pool Pool
		err := rows.Scan(
			&pool.ID, &pool.PoolAddress, &pool.DexName, &pool.DexRouter, &pool.ChainID,
			&pool.Token0Address, &pool.Token0Symbol, &pool.Token1Address, &pool.Token1Symbol,
			&pool.Reserve0, &pool.Reserve1, &pool.LiquidityUSD, &pool.FeeRate, &pool.IsActive,
		)
		if err != nil {
			return nil, err
		}
		pools = append(pools, pool)
	}

	return pools, nil
}

// FindTwoHopRoute 查找两跳交易路由
func (bot *DexBot) FindTwoHopRoute(chainID int, tokenIn, tokenOut string, minLiquidity float64) ([]Route, error) {
	query := `
		WITH first_hop AS (
			SELECT 
				id, pool_address, dex_name, dex_router,
				token0_address, token0_symbol, token1_address, token1_symbol,
				reserve0, reserve1, liquidity_usd, fee_rate,
				CASE 
					WHEN token0_address = ? THEN token1_address
					ELSE token0_address 
				END as intermediate_token,
				CASE 
					WHEN token0_address = ? THEN token1_symbol
					ELSE token0_symbol 
				END as intermediate_symbol
			FROM token_liquidity_pools
			WHERE chain_id = ?
				AND is_active = 1
				AND (token0_address = ? OR token1_address = ?)
				AND liquidity_usd > ?
		)
		SELECT 
			fh.id, fh.pool_address, fh.dex_name, fh.dex_router,
			fh.token0_address, fh.token0_symbol, fh.token1_address, fh.token1_symbol,
			fh.reserve0, fh.reserve1, fh.liquidity_usd, fh.fee_rate,
			fh.intermediate_token,
			tlp.id, tlp.pool_address, tlp.dex_name, tlp.dex_router,
			tlp.token0_address, tlp.token0_symbol, tlp.token1_address, tlp.token1_symbol,
			tlp.reserve0, tlp.reserve1, tlp.liquidity_usd, tlp.fee_rate,
			(fh.liquidity_usd + tlp.liquidity_usd) / 2 as avg_liquidity
		FROM first_hop fh
		JOIN token_liquidity_pools tlp 
			ON tlp.chain_id = ?
			AND tlp.is_active = 1
			AND (
				(tlp.token0_address = fh.intermediate_token AND tlp.token1_address = ?)
				OR (tlp.token1_address = fh.intermediate_token AND tlp.token0_address = ?)
			)
			AND tlp.liquidity_usd > ?
		ORDER BY avg_liquidity DESC
		LIMIT 20
	`

	rows, err := bot.db.Query(query,
		tokenIn, tokenIn, chainID, tokenIn, tokenIn, minLiquidity,
		chainID, tokenOut, tokenOut, minLiquidity,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var routes []Route
	for rows.Next() {
		var (
			pool1             Pool
			pool2             Pool
			intermediateToken string
			avgLiquidity      float64
		)

		err := rows.Scan(
			&pool1.ID, &pool1.PoolAddress, &pool1.DexName, &pool1.DexRouter,
			&pool1.Token0Address, &pool1.Token0Symbol, &pool1.Token1Address, &pool1.Token1Symbol,
			&pool1.Reserve0, &pool1.Reserve1, &pool1.LiquidityUSD, &pool1.FeeRate,
			&intermediateToken,
			&pool2.ID, &pool2.PoolAddress, &pool2.DexName, &pool2.DexRouter,
			&pool2.Token0Address, &pool2.Token0Symbol, &pool2.Token1Address, &pool2.Token1Symbol,
			&pool2.Reserve0, &pool2.Reserve1, &pool2.LiquidityUSD, &pool2.FeeRate,
			&avgLiquidity,
		)
		if err != nil {
			return nil, err
		}

		pool1.IsActive = true
		pool2.IsActive = true

		route := Route{
			Pools:        []Pool{pool1, pool2},
			TokenPath:    []string{tokenIn, intermediateToken, tokenOut},
			TotalFee:     1 - (1-pool1.FeeRate)*(1-pool2.FeeRate),
			AvgLiquidity: avgLiquidity,
		}

		routes = append(routes, route)
	}

	return routes, nil
}

// GetTokenPools 获取某个代币的所有池子
func (bot *DexBot) GetTokenPools(chainID int, tokenAddress string) ([]Pool, error) {
	query := `
		SELECT 
			id, pool_address, dex_name, dex_router, chain_id,
			token0_address, token0_symbol, token1_address, token1_symbol,
			reserve0, reserve1, liquidity_usd, fee_rate, is_active
		FROM token_liquidity_pools
		WHERE chain_id = ?
			AND is_active = 1
			AND (token0_address = ? OR token1_address = ?)
		ORDER BY liquidity_usd DESC
		LIMIT 50
	`

	rows, err := bot.db.Query(query, chainID, tokenAddress, tokenAddress)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pools []Pool
	for rows.Next() {
		var pool Pool
		err := rows.Scan(
			&pool.ID, &pool.PoolAddress, &pool.DexName, &pool.DexRouter, &pool.ChainID,
			&pool.Token0Address, &pool.Token0Symbol, &pool.Token1Address, &pool.Token1Symbol,
			&pool.Reserve0, &pool.Reserve1, &pool.LiquidityUSD, &pool.FeeRate, &pool.IsActive,
		)
		if err != nil {
			return nil, err
		}
		pools = append(pools, pool)
	}

	return pools, nil
}

// GetStats 获取统计信息
func (bot *DexBot) GetStats() (map[string]interface{}, error) {
	stats := make(map[string]interface{})

	// 总池子数
	var totalPools int
	err := bot.db.QueryRow("SELECT COUNT(*) FROM token_liquidity_pools WHERE is_active = 1").Scan(&totalPools)
	if err != nil {
		return nil, err
	}
	stats["total_pools"] = totalPools

	// 总流动性
	var totalLiquidity float64
	err = bot.db.QueryRow("SELECT COALESCE(SUM(liquidity_usd), 0) FROM token_liquidity_pools WHERE is_active = 1").Scan(&totalLiquidity)
	if err != nil {
		return nil, err
	}
	stats["total_liquidity_usd"] = totalLiquidity

	// 按链统计
	chainQuery := `
		SELECT chain_id, COUNT(*) as pool_count, COALESCE(SUM(liquidity_usd), 0) as total_liquidity
		FROM token_liquidity_pools
		WHERE is_active = 1
		GROUP BY chain_id
	`
	rows, err := bot.db.Query(chainQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	chainStats := make([]map[string]interface{}, 0)
	for rows.Next() {
		var chainID, poolCount int
		var liquidity float64
		if err := rows.Scan(&chainID, &poolCount, &liquidity); err != nil {
			continue
		}
		chainStats = append(chainStats, map[string]interface{}{
			"chain_id":        chainID,
			"pool_count":      poolCount,
			"total_liquidity": liquidity,
		})
	}
	stats["chains"] = chainStats

	// 按 DEX 统计
	dexQuery := `
		SELECT dex_name, COUNT(*) as pool_count, COALESCE(SUM(liquidity_usd), 0) as total_liquidity
		FROM token_liquidity_pools
		WHERE is_active = 1
		GROUP BY dex_name
	`
	rows2, err := bot.db.Query(dexQuery)
	if err != nil {
		return nil, err
	}
	defer rows2.Close()

	dexStats := make([]map[string]interface{}, 0)
	for rows2.Next() {
		var dexName string
		var poolCount int
		var liquidity float64
		if err := rows2.Scan(&dexName, &poolCount, &liquidity); err != nil {
			continue
		}
		dexStats = append(dexStats, map[string]interface{}{
			"dex_name":        dexName,
			"pool_count":      poolCount,
			"total_liquidity": liquidity,
		})
	}
	stats["dexes"] = dexStats

	return stats, nil
}

// PoolInfo PostgreSQL pools 表的结构
type PoolInfo struct {
	Address      string
	Token0       string
	Token1       string
	Fee          int64
	Liquidity    string
	SqrtPriceX96 string
	Tick         int64
	Reserve0     string
	Reserve1     string
}

// FindBestPool 查找最佳池子（从 PostgreSQL pools 表）
func (bot *DexBot) FindBestPool(tokenIn, tokenOut string) (*PoolInfo, error) {
	// 使用 LOWER 进行大小写不敏感匹配
	query := `
		SELECT address, token0, token1, fee, liquidity, sqrt_price_x96, tick, reserve0, reserve1
		FROM pools
		WHERE (LOWER(token0) = LOWER($1) AND LOWER(token1) = LOWER($2)) 
		   OR (LOWER(token0) = LOWER($2) AND LOWER(token1) = LOWER($1))
		ORDER BY liquidity DESC
		LIMIT 1
	`

	var pool PoolInfo
	var token0, token1 string
	var reserve0, reserve1 sql.NullString
	err := bot.db.QueryRow(query, tokenIn, tokenOut).Scan(
		&pool.Address, &token0, &token1, &pool.Fee,
		&pool.Liquidity, &pool.SqrtPriceX96, &pool.Tick, &reserve0, &reserve1,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("未找到交易对池子")
		}
		return nil, err
	}

	pool.Token0 = token0
	pool.Token1 = token1
	
	// 设置 reserve0 和 reserve1
	if reserve0.Valid {
		pool.Reserve0 = reserve0.String
	} else {
		pool.Reserve0 = "0"
	}
	if reserve1.Valid {
		pool.Reserve1 = reserve1.String
	} else {
		pool.Reserve1 = "0"
	}

	return &pool, nil
}

// CalculateQuote 计算交易报价（使用 Uniswap V3 简化公式）
func (bot *DexBot) CalculateQuote(pool *PoolInfo, tokenIn, amountIn string) (string, error) {
	// 解析大数
	amountInBig, ok := new(big.Int).SetString(amountIn, 10)
	if !ok {
		return "", fmt.Errorf("无效的输入金额: %s", amountIn)
	}

	liquidity, ok := new(big.Int).SetString(pool.Liquidity, 10)
	if !ok {
		return "", fmt.Errorf("无效的流动性: %s", pool.Liquidity)
	}

	sqrtPriceX96, ok := new(big.Int).SetString(pool.SqrtPriceX96, 10)
	if !ok {
		return "", fmt.Errorf("无效的价格: %s", pool.SqrtPriceX96)
	}

	// Q96 = 2^96
	Q96 := new(big.Int).Exp(big.NewInt(2), big.NewInt(96), nil)

	// 检查价格和流动性是否为零
	if sqrtPriceX96.Cmp(big.NewInt(0)) == 0 || liquidity.Cmp(big.NewInt(0)) == 0 {
		return "", fmt.Errorf("池子没有足够的流动性")
	}

	// 计算手续费（fee 是基点，例如 3000 表示 0.3%）
	// feeMultiplier = 1000000 - fee
	feeMultiplier := new(big.Int).Sub(big.NewInt(1000000), big.NewInt(pool.Fee))
	amountInAfterFee := new(big.Int).Mul(amountInBig, feeMultiplier)
	amountInAfterFee.Div(amountInAfterFee, big.NewInt(1000000))

	// 判断 tokenIn 是 token0 还是 token1
	tokenInLower := strings.ToLower(tokenIn)
	token0Lower := strings.ToLower(pool.Token0)
	isToken0 := tokenInLower == token0Lower

	// 优先使用数据库中的实际储备，如果没有则计算虚拟储备
	var reserve0, reserve1 *big.Int
	
	if pool.Reserve0 != "" && pool.Reserve0 != "0" {
		// 使用数据库中的实际储备
		reserve0, _ = new(big.Int).SetString(pool.Reserve0, 10)
	} else {
		// 计算虚拟储备
		// reserve0 = liquidity * Q96 / sqrtPriceX96
		reserve0 = new(big.Int).Mul(liquidity, Q96)
		reserve0.Div(reserve0, sqrtPriceX96)
	}
	
	if pool.Reserve1 != "" && pool.Reserve1 != "0" {
		// 使用数据库中的实际储备
		reserve1, _ = new(big.Int).SetString(pool.Reserve1, 10)
	} else {
		// 计算虚拟储备
		// reserve1 = liquidity * sqrtPriceX96 / Q96
		reserve1 = new(big.Int).Mul(liquidity, sqrtPriceX96)
		reserve1.Div(reserve1, Q96)
	}

	var amountOut *big.Int

	if isToken0 {
		// token0 -> token1 (zeroForOne)
		// 使用恒定乘积公式: dy = y * dx / (x + dx)
		// amountOut = reserve1 * amountInAfterFee / (reserve0 + amountInAfterFee)
		numerator := new(big.Int).Mul(reserve1, amountInAfterFee)
		denominator := new(big.Int).Add(reserve0, amountInAfterFee)
		amountOut = new(big.Int).Div(numerator, denominator)
	} else {
		// token1 -> token0 (oneForZero)
		// amountOut = reserve0 * amountInAfterFee / (reserve1 + amountInAfterFee)
		numerator := new(big.Int).Mul(reserve0, amountInAfterFee)
		denominator := new(big.Int).Add(reserve1, amountInAfterFee)
		amountOut = new(big.Int).Div(numerator, denominator)
	}

	return amountOut.String(), nil
}

// Close 关闭数据库连接
func (bot *DexBot) Close() error {
	return bot.db.Close()
}
