package api

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// CalculateOutputAmount 使用恒定乘积公式计算输出金额
// 公式: Δy = (y × Δx × (1 - fee)) / (x + Δx × (1 - fee))
// 这是 Uniswap V2 风格的 AMM 公式
func CalculateOutputAmount(amountIn, reserveIn, reserveOut *big.Int, feeRate float64) *big.Int {
	if amountIn.Cmp(big.NewInt(0)) <= 0 {
		return big.NewInt(0)
	}
	if reserveIn.Cmp(big.NewInt(0)) <= 0 || reserveOut.Cmp(big.NewInt(0)) <= 0 {
		return big.NewInt(0)
	}

	// 计算手续费后的输入金额
	// (1 - feeRate) × 10000，例如 0.997 × 10000 = 9970
	feeMultiplier := int64((1 - feeRate) * 10000)
	amountInWithFee := new(big.Int).Mul(amountIn, big.NewInt(feeMultiplier))
	amountInWithFee.Div(amountInWithFee, big.NewInt(10000))

	// 分子: amountInWithFee × reserveOut
	numerator := new(big.Int).Mul(amountInWithFee, reserveOut)

	// 分母: reserveIn + amountInWithFee
	denominator := new(big.Int).Add(reserveIn, amountInWithFee)

	// 计算输出
	if denominator.Cmp(big.NewInt(0)) == 0 {
		return big.NewInt(0)
	}
	amountOut := new(big.Int).Div(numerator, denominator)
	return amountOut
}

// RouteScore 路由评分结构
type RouteScore struct {
	Route          Route   `json:"route"`
	LiquidityScore float64 `json:"liquidity_score"`      // 流动性得分 (0-100)
	FeeScore       float64 `json:"fee_score"`            // 手续费得分 (0-100)
	PriceScore     float64 `json:"price_score"`          // 价格得分 (0-100)
	TotalScore     float64 `json:"total_score"`          // 综合得分
	AmountOut      string  `json:"amount_out"`           // 预期输出金额
	BottleneckLiq  float64 `json:"bottleneck_liquidity"` // 瓶颈流动性
}

// GetBottleneckLiquidity 计算路由的瓶颈流动性
// 瓶颈流动性 = MIN(Pool1.liquidity, Pool2.liquidity, ...)
func GetBottleneckLiquidity(route Route) float64 {
	if len(route.Pools) == 0 {
		return 0
	}

	minLiquidity := route.Pools[0].LiquidityUSD
	for _, pool := range route.Pools {
		if pool.LiquidityUSD < minLiquidity {
			minLiquidity = pool.LiquidityUSD
		}
	}
	return minLiquidity
}

// NormalizeScore 将值标准化到 0-100 分
func NormalizeScore(value, minValue, maxValue float64) float64 {
	if maxValue <= minValue {
		return 50.0 // 默认中等分数
	}
	if value < minValue {
		return 0
	}
	if value > maxValue {
		return 100
	}
	return (value - minValue) / (maxValue - minValue) * 100
}

// SimulateSwap 模拟路由交易，计算输出金额
func (bot *DexBot) SimulateSwap(route Route, amountIn *big.Int) (*big.Int, error) {
	if len(route.Pools) == 0 {
		return nil, fmt.Errorf("路由中没有池子")
	}

	currentAmount := new(big.Int).Set(amountIn)

	// 遍历每个池子进行交换
	for i, pool := range route.Pools {
		// 确定输入和输出代币
		var reserveIn, reserveOut *big.Int
		var tokenIn string

		if i == 0 {
			// 第一跳：从 tokenIn 开始
			tokenIn = route.TokenPath[0]
		} else {
			// 后续跳：使用上一跳的输出代币
			tokenIn = route.TokenPath[i]
		}

		// 判断 tokenIn 是 token0 还是 token1
		if strings.EqualFold(pool.Token0Address, tokenIn) {
			reserveIn, _ = new(big.Int).SetString(pool.Reserve0, 10)
			reserveOut, _ = new(big.Int).SetString(pool.Reserve1, 10)
		} else {
			reserveIn, _ = new(big.Int).SetString(pool.Reserve1, 10)
			reserveOut, _ = new(big.Int).SetString(pool.Reserve0, 10)
		}

		// 检查储备是否有效
		if reserveIn == nil || reserveOut == nil {
			return nil, fmt.Errorf("池子 %s 的储备数据无效", pool.PoolAddress)
		}

		// 计算这一跳的输出
		currentAmount = CalculateOutputAmount(currentAmount, reserveIn, reserveOut, pool.FeeRate)
		if currentAmount.Cmp(big.NewInt(0)) <= 0 {
			return nil, fmt.Errorf("池子 %s 输出金额为 0", pool.PoolAddress)
		}
	}

	return currentAmount, nil
}

// CalculateRouteScore 计算路由的综合评分
func (bot *DexBot) CalculateRouteScore(route Route, amountIn *big.Int) (RouteScore, error) {
	score := RouteScore{
		Route: route,
	}

	// 1. 流动性得分（越高越好）
	bottleneckLiquidity := GetBottleneckLiquidity(route)
	score.BottleneckLiq = bottleneckLiquidity
	// 流动性范围：$10,000 - $100,000,000
	score.LiquidityScore = NormalizeScore(bottleneckLiquidity, 10000, 100000000)

	// 2. 手续费得分（越低越好，转换为越高越好）
	totalFee := route.TotalFee
	// 手续费范围：0% - 2%，转换为得分
	score.FeeScore = 100 - (totalFee * 50) // 0% = 100分, 2% = 0分
	if score.FeeScore < 0 {
		score.FeeScore = 0
	}
	if score.FeeScore > 100 {
		score.FeeScore = 100
	}

	// 3. 价格得分（根据实际输出计算）
	expectedOutput, err := bot.SimulateSwap(route, amountIn)
	if err != nil {
		return score, fmt.Errorf("模拟交易失败: %w", err)
	}
	score.AmountOut = expectedOutput.String()

	// 计算理论价格（无手续费情况下的价格）
	// 这里简化处理，使用第一跳池子的价格作为参考
	if len(route.Pools) > 0 {
		pool := route.Pools[0]
		var reserve0, reserve1 *big.Int
		reserve0, _ = new(big.Int).SetString(pool.Reserve0, 10)
		reserve1, _ = new(big.Int).SetString(pool.Reserve1, 10)

		if reserve0 != nil && reserve1 != nil && reserve0.Cmp(big.NewInt(0)) > 0 {
			// 理论输出 = amountIn * reserve1 / reserve0
			theoreticalOutput := new(big.Int).Mul(amountIn, reserve1)
			theoreticalOutput.Div(theoreticalOutput, reserve0)

			// 实际输出与理论输出的比例
			if theoreticalOutput.Cmp(big.NewInt(0)) > 0 {
				ratio := new(big.Int).Mul(expectedOutput, big.NewInt(10000))
				ratio.Div(ratio, theoreticalOutput)
				// 比例越高越好，95%以上为满分
				ratioFloat := float64(ratio.Int64()) / 100.0
				score.PriceScore = NormalizeScore(ratioFloat, 90, 100)
			} else {
				score.PriceScore = 50
			}
		} else {
			score.PriceScore = 50
		}
	} else {
		score.PriceScore = 50
	}

	// 4. 综合得分（加权平均）
	// 权重：流动性 40%，手续费 30%，价格 30%
	score.TotalScore = score.LiquidityScore*0.4 +
		score.FeeScore*0.3 +
		score.PriceScore*0.3

	return score, nil
}

// FindBestRoute 查找最优路由（综合考虑单跳和多跳）
func (bot *DexBot) FindBestRoute(chainID int, tokenIn, tokenOut string, amountIn *big.Int, minLiquidity float64) (RouteScore, error) {
	var allRoutes []Route

	// 1. 查找直接路由（单跳）
	directPools, err := bot.FindDirectRoute(chainID, tokenIn, tokenOut)
	if err == nil {
		for _, pool := range directPools {
			route := Route{
				Pools:        []Pool{pool},
				TokenPath:    []string{tokenIn, tokenOut},
				TotalFee:     pool.FeeRate,
				AvgLiquidity: pool.LiquidityUSD,
			}
			allRoutes = append(allRoutes, route)
		}
	}

	// 2. 查找两跳路由
	twoHopRoutes, err := bot.FindTwoHopRoute(chainID, tokenIn, tokenOut, minLiquidity)
	if err == nil {
		allRoutes = append(allRoutes, twoHopRoutes...)
	}

	// 3. 查找三跳路由（如果两跳没有找到好的路径）
	if len(allRoutes) == 0 || len(twoHopRoutes) < 3 {
		threeHopRoutes, err := bot.FindThreeHopRoute(chainID, tokenIn, tokenOut, minLiquidity)
		if err == nil {
			allRoutes = append(allRoutes, threeHopRoutes...)
		}
	}

	if len(allRoutes) == 0 {
		return RouteScore{}, fmt.Errorf("未找到任何路由")
	}

	// 4. 计算每个路由的评分
	var scoredRoutes []RouteScore
	for _, route := range allRoutes {
		score, err := bot.CalculateRouteScore(route, amountIn)
		if err != nil {
			continue // 跳过无法计算的路由
		}
		scoredRoutes = append(scoredRoutes, score)
	}

	if len(scoredRoutes) == 0 {
		return RouteScore{}, fmt.Errorf("无法计算路由评分")
	}

	// 5. 按综合得分排序
	sort.Slice(scoredRoutes, func(i, j int) bool {
		return scoredRoutes[i].TotalScore > scoredRoutes[j].TotalScore
	})

	// 返回最优路由
	return scoredRoutes[0], nil
}

// FindThreeHopRoute 查找三跳交易路由
func (bot *DexBot) FindThreeHopRoute(chainID int, tokenIn, tokenOut string, minLiquidity float64) ([]Route, error) {
	// 使用 SQL CTE 实现三跳搜索
	query := `
		WITH first_hop AS (
			SELECT 
				id, pool_address, dex_name, dex_router,
				token0_address, token0_symbol, token1_address, token1_symbol,
				reserve0, reserve1, liquidity_usd, fee_rate,
				CASE 
					WHEN token0_address = ? THEN token1_address
					ELSE token0_address 
				END as intermediate_token1
			FROM token_liquidity_pools
			WHERE chain_id = ?
				AND is_active = 1
				AND (token0_address = ? OR token1_address = ?)
				AND liquidity_usd > ?
		),
		second_hop AS (
			SELECT 
				fh.id as pool1_id, fh.pool_address as pool1_address, fh.dex_name as pool1_dex_name,
				fh.dex_router as pool1_dex_router,
				fh.token0_address as pool1_token0, fh.token0_symbol as pool1_token0_symbol,
				fh.token1_address as pool1_token1, fh.token1_symbol as pool1_token1_symbol,
				fh.reserve0 as pool1_reserve0, fh.reserve1 as pool1_reserve1,
				fh.liquidity_usd as pool1_liquidity, fh.fee_rate as pool1_fee_rate,
				fh.intermediate_token1,
				tlp.id as pool2_id, tlp.pool_address as pool2_address, tlp.dex_name as pool2_dex_name,
				tlp.dex_router as pool2_dex_router,
				tlp.token0_address as pool2_token0, tlp.token0_symbol as pool2_token0_symbol,
				tlp.token1_address as pool2_token1, tlp.token1_symbol as pool2_token1_symbol,
				tlp.reserve0 as pool2_reserve0, tlp.reserve1 as pool2_reserve1,
				tlp.liquidity_usd as pool2_liquidity, tlp.fee_rate as pool2_fee_rate,
				CASE 
					WHEN tlp.token0_address = fh.intermediate_token1 THEN tlp.token1_address
					ELSE tlp.token0_address 
				END as intermediate_token2
			FROM first_hop fh
			JOIN token_liquidity_pools tlp 
				ON tlp.chain_id = ?
				AND tlp.is_active = 1
				AND (
					(tlp.token0_address = fh.intermediate_token1 AND tlp.token1_address != ?)
					OR (tlp.token1_address = fh.intermediate_token1 AND tlp.token0_address != ?)
				)
				AND tlp.liquidity_usd > ?
		)
		SELECT 
			sh.pool1_id, sh.pool1_address, sh.pool1_dex_name, sh.pool1_dex_router,
			sh.pool1_token0, sh.pool1_token0_symbol, sh.pool1_token1, sh.pool1_token1_symbol,
			sh.pool1_reserve0, sh.pool1_reserve1, sh.pool1_liquidity, sh.pool1_fee_rate,
			sh.intermediate_token1,
			sh.pool2_id, sh.pool2_address, sh.pool2_dex_name, sh.pool2_dex_router,
			sh.pool2_token0, sh.pool2_token0_symbol, sh.pool2_token1, sh.pool2_token1_symbol,
			sh.pool2_reserve0, sh.pool2_reserve1, sh.pool2_liquidity, sh.pool2_fee_rate,
			sh.intermediate_token2,
			tlp.id as pool3_id, tlp.pool_address as pool3_address, tlp.dex_name as pool3_dex_name,
			tlp.dex_router as pool3_dex_router,
			tlp.token0_address as pool3_token0, tlp.token0_symbol as pool3_token0_symbol,
			tlp.token1_address as pool3_token1, tlp.token1_symbol as pool3_token1_symbol,
			tlp.reserve0 as pool3_reserve0, tlp.reserve1 as pool3_reserve1,
			tlp.liquidity_usd as pool3_liquidity, tlp.fee_rate as pool3_fee_rate,
			(sh.pool1_liquidity + sh.pool2_liquidity + tlp.liquidity_usd) / 3 as avg_liquidity
		FROM second_hop sh
		JOIN token_liquidity_pools tlp 
			ON tlp.chain_id = ?
			AND tlp.is_active = 1
			AND (
				(tlp.token0_address = sh.intermediate_token2 AND tlp.token1_address = ?)
				OR (tlp.token1_address = sh.intermediate_token2 AND tlp.token0_address = ?)
			)
			AND tlp.liquidity_usd > ?
		ORDER BY avg_liquidity DESC
		LIMIT 10
	`

	rows, err := bot.db.Query(query,
		tokenIn, chainID, tokenIn, tokenIn, minLiquidity, // first_hop
		chainID, tokenOut, tokenOut, minLiquidity, // second_hop
		chainID, tokenOut, tokenOut, minLiquidity, // third_hop
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var routes []Route
	for rows.Next() {
		var (
			pool1              Pool
			pool2              Pool
			pool3              Pool
			intermediateToken1 string
			intermediateToken2 string
			avgLiquidity       float64
		)

		err := rows.Scan(
			&pool1.ID, &pool1.PoolAddress, &pool1.DexName, &pool1.DexRouter,
			&pool1.Token0Address, &pool1.Token0Symbol, &pool1.Token1Address, &pool1.Token1Symbol,
			&pool1.Reserve0, &pool1.Reserve1, &pool1.LiquidityUSD, &pool1.FeeRate,
			&intermediateToken1,
			&pool2.ID, &pool2.PoolAddress, &pool2.DexName, &pool2.DexRouter,
			&pool2.Token0Address, &pool2.Token0Symbol, &pool2.Token1Address, &pool2.Token1Symbol,
			&pool2.Reserve0, &pool2.Reserve1, &pool2.LiquidityUSD, &pool2.FeeRate,
			&intermediateToken2,
			&pool3.ID, &pool3.PoolAddress, &pool3.DexName, &pool3.DexRouter,
			&pool3.Token0Address, &pool3.Token0Symbol, &pool3.Token1Address, &pool3.Token1Symbol,
			&pool3.Reserve0, &pool3.Reserve1, &pool3.LiquidityUSD, &pool3.FeeRate,
			&avgLiquidity,
		)
		if err != nil {
			return nil, err
		}

		pool1.IsActive = true
		pool2.IsActive = true
		pool3.IsActive = true

		// 计算总手续费
		totalFee := 1 - (1-pool1.FeeRate)*(1-pool2.FeeRate)*(1-pool3.FeeRate)

		route := Route{
			Pools:        []Pool{pool1, pool2, pool3},
			TokenPath:    []string{tokenIn, intermediateToken1, intermediateToken2, tokenOut},
			TotalFee:     totalFee,
			AvgLiquidity: avgLiquidity,
		}

		routes = append(routes, route)
	}

	return routes, nil
}
