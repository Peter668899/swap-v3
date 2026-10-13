package scanner

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

// ERC20 ABI 定义（仅包含我们需要的方法）
var erc20ABI = `[
	{
		"constant": true,
		"inputs": [],
		"name": "symbol",
		"outputs": [{"name": "", "type": "string"}],
		"type": "function"
	},
	{
		"constant": true,
		"inputs": [],
		"name": "name",
		"outputs": [{"name": "", "type": "string"}],
		"type": "function"
	},
	{
		"constant": true,
		"inputs": [],
		"name": "decimals",
		"outputs": [{"name": "", "type": "uint8"}],
		"type": "function"
	},
	{
		"constant": true,
		"inputs": [{"name": "account", "type": "address"}],
		"name": "balanceOf",
		"outputs": [{"name": "", "type": "uint256"}],
		"type": "function"
	}
]`

// ensureToken 确保代币记录存在于数据库中，从 ERC20 合约读取 symbol、name 和 decimals
func (s *Scanner) ensureToken(addr common.Address) {
	// 先检查数据库中是否已存在
	var exists bool
	err := s.DB.QueryRow(`
		SELECT EXISTS(SELECT 1 FROM tokens WHERE address = $1)
	`, addr.Hex()).Scan(&exists)
	if err != nil {
		log.Printf("Error checking token existence: %v", err)
		return
	}
	if exists {
		// 代币已存在，跳过
		return
	}

	// 从 ERC20 合约读取信息
	symbol := "UNK"
	name := "Unknown"
	decimals := int64(18)

	parsedABI, err := abi.JSON(strings.NewReader(erc20ABI))
	if err != nil {
		log.Printf("Error parsing ERC20 ABI: %v", err)
		// 使用默认值插入
		s.insertToken(addr, symbol, name, decimals)
		return
	}

	ctx := context.Background()

	// 调用 symbol()
	if symbolMethod, ok := parsedABI.Methods["symbol"]; ok {
		data, err := parsedABI.Pack("symbol")
		if err == nil {
			result, err := s.Client.CallContract(ctx, ethereum.CallMsg{
				To:   &addr,
				Data: data,
			}, nil)
			if err == nil {
				unpacked, err := symbolMethod.Outputs.Unpack(result)
				if err == nil && len(unpacked) > 0 {
					if s, ok := unpacked[0].(string); ok {
						symbol = s
					}
				}
			}
		}
	}

	// 调用 name()
	if nameMethod, ok := parsedABI.Methods["name"]; ok {
		data, err := parsedABI.Pack("name")
		if err == nil {
			result, err := s.Client.CallContract(ctx, ethereum.CallMsg{
				To:   &addr,
				Data: data,
			}, nil)
			if err == nil {
				unpacked, err := nameMethod.Outputs.Unpack(result)
				if err == nil && len(unpacked) > 0 {
					if n, ok := unpacked[0].(string); ok {
						name = n
					}
				}
			}
		}
	}

	// 调用 decimals()
	if decimalsMethod, ok := parsedABI.Methods["decimals"]; ok {
		data, err := parsedABI.Pack("decimals")
		if err == nil {
			result, err := s.Client.CallContract(ctx, ethereum.CallMsg{
				To:   &addr,
				Data: data,
			}, nil)
			if err == nil {
				unpacked, err := decimalsMethod.Outputs.Unpack(result)
				if err == nil && len(unpacked) > 0 {
					// decimals 返回 uint8
					switch v := unpacked[0].(type) {
					case uint8:
						decimals = int64(v)
					case uint16:
						decimals = int64(v)
					case uint32:
						decimals = int64(v)
					case uint64:
						decimals = int64(v)
					case *big.Int:
						decimals = v.Int64()
					default:
						log.Printf("Unexpected decimals type for token %s: %T", addr.Hex(), v)
					}
				}
			}
		}
	}

	// 插入数据库
	s.insertToken(addr, symbol, name, decimals)
}

// insertToken 将代币信息插入数据库
func (s *Scanner) insertToken(addr common.Address, symbol, name string, decimals int64) {
	_, err := s.DB.Exec(`
		INSERT INTO tokens (address, symbol, name, decimals)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (address) DO NOTHING
	`, addr.Hex(), symbol, name, decimals)
	if err != nil {
		log.Printf("Error inserting token: %v", err)
	} else {
		log.Printf("Inserted token: %s (symbol=%s, name=%s, decimals=%d)", addr.Hex(), symbol, name, decimals)
	}
}

// ensurePoolExists 尝试从数据库加载池子信息，如果不存在则创建一个基本记录
func (s *Scanner) ensurePoolExists(poolAddr common.Address) {
	// Check if pool exists in DB
	var exists bool
	err := s.DB.QueryRow(`
		SELECT EXISTS(SELECT 1 FROM pools WHERE address = $1)
	`, poolAddr.Hex()).Scan(&exists)

	if err != nil {
		log.Printf("Error checking pool existence: %v", err)
		return
	}

	if exists {
		// Pool exists in DB, add to cache
		s.Pools[poolAddr] = true
	} else {
		// Pool doesn't exist in DB, we can't create it without pool creation event
		// But we can still add it to cache to process events
		s.Pools[poolAddr] = true
	}
}

// updateTicksFromMint 从 Mint 事件更新 ticks 表的流动性
// 注意：在这个简化实现中，所有流动性都在池子的 tickLower 到 tickUpper 之间
// 所以我们需要更新这两个边界 tick 的流动性
func (s *Scanner) updateTicksFromMint(poolAddr common.Address, liquidity *big.Int) {
	// 查询池子的 tick_lower 和 tick_upper
	var tickLower, tickUpper int
	err := s.DB.QueryRow(`
		SELECT tick_lower, tick_upper FROM pools WHERE address = $1
	`, poolAddr.Hex()).Scan(&tickLower, &tickUpper)
	if err != nil {
		log.Printf("Error querying pool ticks for update: %v", err)
		return
	}

	// 更新 tick_lower 的流动性
	// liquidity_gross: 总流动性（累加）
	// liquidity_net: 净流动性变化（向上为正，这里在 tickLower 处，价格向上移动时流动性增加）
	_, err = s.DB.Exec(`
		INSERT INTO ticks (
			pool_address, tick_index, liquidity_gross, liquidity_net,
			fee_growth_outside0_x128, fee_growth_outside1_x128
		) VALUES ($1, $2, $3, $4, 0, 0)
		ON CONFLICT (pool_address, tick_index) DO UPDATE SET
			liquidity_gross = ticks.liquidity_gross + $3,
			liquidity_net = ticks.liquidity_net + $4,
			updated_at = NOW()
	`, poolAddr.Hex(), tickLower, liquidity.String(), liquidity.String())
	if err != nil {
		log.Printf("Error updating tick_lower: %v", err)
	}

	// 更新 tick_upper 的流动性
	// 在 tickUpper 处，价格向上移动时流动性减少（所以 liquidity_net 为负）
	liquidityNeg := new(big.Int).Neg(liquidity)
	_, err = s.DB.Exec(`
		INSERT INTO ticks (
			pool_address, tick_index, liquidity_gross, liquidity_net,
			fee_growth_outside0_x128, fee_growth_outside1_x128
		) VALUES ($1, $2, $3, $4, 0, 0)
		ON CONFLICT (pool_address, tick_index) DO UPDATE SET
			liquidity_gross = ticks.liquidity_gross + $3,
			liquidity_net = ticks.liquidity_net + $4,
			updated_at = NOW()
	`, poolAddr.Hex(), tickUpper, liquidity.String(), liquidityNeg.String())
	if err != nil {
		log.Printf("Error updating tick_upper: %v", err)
	}
}

// updateTicksFromBurn 从 Burn 事件更新 ticks 表的流动性
func (s *Scanner) updateTicksFromBurn(poolAddr common.Address, liquidity *big.Int) {
	// 查询池子的 tick_lower 和 tick_upper
	var tickLower, tickUpper int
	err := s.DB.QueryRow(`
		SELECT tick_lower, tick_upper FROM pools WHERE address = $1
	`, poolAddr.Hex()).Scan(&tickLower, &tickUpper)
	if err != nil {
		log.Printf("Error querying pool ticks for update: %v", err)
		return
	}

	// 更新 tick_lower 的流动性（减少）
	_, err = s.DB.Exec(`
		UPDATE ticks SET
			liquidity_gross = GREATEST(0, liquidity_gross - $1),
			liquidity_net = liquidity_net - $1,
			updated_at = NOW()
		WHERE pool_address = $2 AND tick_index = $3
	`, liquidity.String(), poolAddr.Hex(), tickLower)
	if err != nil {
		log.Printf("Error updating tick_lower on burn: %v", err)
	}

	// 更新 tick_upper 的流动性（减少，liquidity_net 增加，因为负值减少）
	_, err = s.DB.Exec(`
		UPDATE ticks SET
			liquidity_gross = GREATEST(0, liquidity_gross - $1),
			liquidity_net = liquidity_net + $1,
			updated_at = NOW()
		WHERE pool_address = $2 AND tick_index = $3
	`, liquidity.String(), poolAddr.Hex(), tickUpper)
	if err != nil {
		log.Printf("Error updating tick_upper on burn: %v", err)
	}
}

// getPoolLiquidity 查询 Pool 合约的当前流动性
// 注意：这需要 Pool 合约有 liquidity() 方法，如果查询失败则返回错误
// 目前未实现，因为我们可以从 Swap 事件中获取流动性，或者使用累加/累减方式
func (s *Scanner) getPoolLiquidity(poolAddr common.Address, blockNumber uint64) (*big.Int, error) {
	// 未实现，返回错误
	return nil, fmt.Errorf("not implemented")
}

// checkContractExists 检查合约是否存在（有代码）
func (s *Scanner) checkContractExists(addr common.Address) bool {
	ctx := context.Background()
	code, err := s.Client.CodeAt(ctx, addr, nil)
	if err != nil {
		return false
	}
	return len(code) > 0
}

// updatePoolReserves 更新池子的 reserve0 和 reserve1
// 通过调用 token0 和 token1 的 balanceOf(poolAddress) 获取余额
func (s *Scanner) updatePoolReserves(poolAddr common.Address) {
	// 查询池子的 token0 和 token1 地址
	var token0Addr, token1Addr string
	err := s.DB.QueryRow(`
		SELECT token0, token1 FROM pools WHERE address = $1
	`, poolAddr.Hex()).Scan(&token0Addr, &token1Addr)
	if err != nil {
		log.Printf("Error querying pool tokens for reserve update (pool=%s): %v", poolAddr.Hex(), err)
		return
	}

	token0 := common.HexToAddress(token0Addr)
	token1 := common.HexToAddress(token1Addr)

	// 检查合约是否存在
	if !s.checkContractExists(token0) {
		log.Printf("⚠️  Token0 contract does not exist or has no code (pool=%s, token=%s), skipping", poolAddr.Hex(), token0.Hex())
		return
	}
	if !s.checkContractExists(token1) {
		log.Printf("⚠️  Token1 contract does not exist or has no code (pool=%s, token=%s), skipping", poolAddr.Hex(), token1.Hex())
		return
	}

	// 解析 ERC20 ABI
	parsedABI, err := abi.JSON(strings.NewReader(erc20ABI))
	if err != nil {
		log.Printf("Error parsing ERC20 ABI for reserve update: %v", err)
		return
	}

	ctx := context.Background()
	var reserve0, reserve1 *big.Int
	var err0, err1 error

	// 获取 token0 余额
	balanceMethod, ok := parsedABI.Methods["balanceOf"]
	if !ok {
		log.Printf("balanceOf method not found in ERC20 ABI")
		return
	}

	data0, err := parsedABI.Pack("balanceOf", poolAddr)
	if err != nil {
		log.Printf("Error packing balanceOf call for token0 (pool=%s, token=%s): %v", poolAddr.Hex(), token0.Hex(), err)
		return
	}

	result0, err := s.Client.CallContract(ctx, ethereum.CallMsg{
		To:   &token0,
		Data: data0,
	}, nil)
	if err != nil {
		// 检查是否是 "function selector was not recognized" 错误
		errStr := err.Error()
		if strings.Contains(errStr, "function selector was not recognized") {
			log.Printf("⚠️  Token0 is not a standard ERC20 contract (pool=%s, token=%s), skipping", poolAddr.Hex(), token0.Hex())
		} else {
			log.Printf("Error calling balanceOf for token0 (pool=%s, token=%s): %v", poolAddr.Hex(), token0.Hex(), err)
		}
		err0 = err
	} else {
		unpacked, err := balanceMethod.Outputs.Unpack(result0)
		if err != nil {
			log.Printf("Error unpacking balanceOf result for token0 (pool=%s, token=%s): %v", poolAddr.Hex(), token0.Hex(), err)
			err0 = err
		} else if len(unpacked) > 0 {
			if balance, ok := unpacked[0].(*big.Int); ok {
				reserve0 = balance
			} else {
				log.Printf("Error: balanceOf result for token0 is not *big.Int (pool=%s, token=%s, type=%T)", poolAddr.Hex(), token0.Hex(), unpacked[0])
				err0 = fmt.Errorf("unexpected type")
			}
		}
	}

	// 获取 token1 余额
	data1, err := parsedABI.Pack("balanceOf", poolAddr)
	if err != nil {
		log.Printf("Error packing balanceOf call for token1 (pool=%s, token=%s): %v", poolAddr.Hex(), token1.Hex(), err)
		return
	}

	result1, err := s.Client.CallContract(ctx, ethereum.CallMsg{
		To:   &token1,
		Data: data1,
	}, nil)
	if err != nil {
		// 检查是否是 "function selector was not recognized" 错误
		errStr := err.Error()
		if strings.Contains(errStr, "function selector was not recognized") {
			log.Printf("⚠️  Token1 is not a standard ERC20 contract (pool=%s, token=%s), skipping", poolAddr.Hex(), token1.Hex())
		} else {
			log.Printf("Error calling balanceOf for token1 (pool=%s, token=%s): %v", poolAddr.Hex(), token1.Hex(), err)
		}
		err1 = err
	} else {
		unpacked, err := balanceMethod.Outputs.Unpack(result1)
		if err != nil {
			log.Printf("Error unpacking balanceOf result for token1 (pool=%s, token=%s): %v", poolAddr.Hex(), token1.Hex(), err)
			err1 = err
		} else if len(unpacked) > 0 {
			if balance, ok := unpacked[0].(*big.Int); ok {
				reserve1 = balance
			} else {
				log.Printf("Error: balanceOf result for token1 is not *big.Int (pool=%s, token=%s, type=%T)", poolAddr.Hex(), token1.Hex(), unpacked[0])
				err1 = fmt.Errorf("unexpected type")
			}
		}
	}

	// 更新数据库（即使只有一个成功也更新，另一个设为0或保持原值）
	if reserve0 != nil && reserve1 != nil {
		_, err = s.DB.Exec(`
			UPDATE pools SET reserve0 = $1, reserve1 = $2
			WHERE address = $3
		`, reserve0.String(), reserve1.String(), poolAddr.Hex())
		if err != nil {
			log.Printf("Error updating pool reserves in DB (pool=%s): %v", poolAddr.Hex(), err)
		} else {
			log.Printf("✅ Updated pool reserves: %s (reserve0=%s, reserve1=%s)",
				poolAddr.Hex(), reserve0.String(), reserve1.String())
		}
	} else if reserve0 != nil {
		// 只有 reserve0 成功，只更新 reserve0
		_, err = s.DB.Exec(`
			UPDATE pools SET reserve0 = $1
			WHERE address = $2
		`, reserve0.String(), poolAddr.Hex())
		if err != nil {
			log.Printf("Error updating pool reserve0 in DB (pool=%s): %v", poolAddr.Hex(), err)
		} else {
			log.Printf("⚠️  Updated pool reserve0 only: %s (reserve0=%s, reserve1=failed)",
				poolAddr.Hex(), reserve0.String())
		}
	} else if reserve1 != nil {
		// 只有 reserve1 成功，只更新 reserve1
		_, err = s.DB.Exec(`
			UPDATE pools SET reserve1 = $1
			WHERE address = $2
		`, reserve1.String(), poolAddr.Hex())
		if err != nil {
			log.Printf("Error updating pool reserve1 in DB (pool=%s): %v", poolAddr.Hex(), err)
		} else {
			log.Printf("⚠️  Updated pool reserve1 only: %s (reserve0=failed, reserve1=%s)",
				poolAddr.Hex(), reserve1.String())
		}
	} else {
		// 两个都失败
		if err0 != nil || err1 != nil {
			// 如果是 "function selector was not recognized" 错误，这是预期的，不需要记录为错误
			err0Str := ""
			err1Str := ""
			if err0 != nil {
				err0Str = err0.Error()
			}
			if err1 != nil {
				err1Str = err1.Error()
			}

			if strings.Contains(err0Str, "function selector was not recognized") &&
				strings.Contains(err1Str, "function selector was not recognized") {
				// 两个都不是标准 ERC20，静默跳过
				log.Printf("⚠️  Skipping pool %s: tokens are not standard ERC20 (token0=%s, token1=%s)",
					poolAddr.Hex(), token0.Hex(), token1.Hex())
			} else {
				log.Printf("❌ Failed to get reserves for pool %s (token0=%s, token1=%s): err0=%v, err1=%v",
					poolAddr.Hex(), token0.Hex(), token1.Hex(), err0, err1)
			}
		} else {
			log.Printf("❌ Failed to get reserves for pool %s: reserve0=%v, reserve1=%v",
				poolAddr.Hex(), reserve0, reserve1)
		}
	}
}

// UpdateAllPoolReserves 更新所有池子的储备（用于手动修复历史数据）
func (s *Scanner) UpdateAllPoolReserves() error {
	log.Println("Starting to update reserves for all pools...")

	// 先查询总数
	var total int
	err := s.DB.QueryRow("SELECT COUNT(*) FROM pools").Scan(&total)
	if err != nil {
		log.Printf("Warning: failed to get total pool count: %v", err)
		total = 0
	}
	log.Printf("Found %d pools to update", total)

	rows, err := s.DB.Query("SELECT address FROM pools")
	if err != nil {
		return fmt.Errorf("failed to query pools: %v", err)
	}
	defer rows.Close()

	count := 0
	successCount := 0
	for rows.Next() {
		var addr string
		if err := rows.Scan(&addr); err != nil {
			log.Printf("Error scanning pool address: %v", err)
			continue
		}

		count++
		if total > 0 {
			log.Printf("Updating reserves for pool %d/%d: %s", count, total, addr)
		} else {
			log.Printf("Updating reserves for pool %d: %s", count, addr)
		}
		s.updatePoolReserves(common.HexToAddress(addr))
		successCount++

		// 添加小延迟避免 RPC 限流
		time.Sleep(100 * time.Millisecond)
	}

	log.Printf("✅ Completed updating reserves: %d/%d pools processed successfully", successCount, count)
	return nil
}
