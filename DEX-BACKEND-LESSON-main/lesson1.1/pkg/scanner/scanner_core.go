package scanner

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"math/big"
	"meta-node-dex-sync/pkg/config"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// NewScanner 创建并初始化 Scanner 实例
func NewScanner(config config.Config, db *sql.DB) (*Scanner, error) {
	client, err := ethclient.Dial(config.RPC.Url)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to infura: %v", err)
	}

	// 解析 PositionManager ABI（用于查询 positions mapping）
	// positions(uint256) 是 public mapping 自动生成的 getter
	positionManagerABIJSON := `[
		{
			"inputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
			"name": "positions",
			"outputs": [
				{"internalType": "uint256", "name": "id", "type": "uint256"},
				{"internalType": "address", "name": "owner", "type": "address"},
				{"internalType": "address", "name": "token0", "type": "address"},
				{"internalType": "address", "name": "token1", "type": "address"},
				{"internalType": "uint32", "name": "index", "type": "uint32"},
				{"internalType": "uint24", "name": "fee", "type": "uint24"},
				{"internalType": "uint128", "name": "liquidity", "type": "uint128"},
				{"internalType": "int24", "name": "tickLower", "type": "int24"},
				{"internalType": "int24", "name": "tickUpper", "type": "int24"},
				{"internalType": "uint128", "name": "tokensOwed0", "type": "uint128"},
				{"internalType": "uint128", "name": "tokensOwed1", "type": "uint128"},
				{"internalType": "uint256", "name": "feeGrowthInside0LastX128", "type": "uint256"},
				{"internalType": "uint256", "name": "feeGrowthInside1LastX128", "type": "uint256"}
			],
			"stateMutability": "view",
			"type": "function"
		}
	]`
	positionManagerABI, err := abi.JSON(strings.NewReader(positionManagerABIJSON))
	if err != nil {
		return nil, fmt.Errorf("failed to parse PositionManager ABI: %v", err)
	}

	scanner := &Scanner{
		Client:             client,
		DB:                 db,
		Config:             config,
		Pools:              make(map[common.Address]bool),
		Current:            uint64(config.RPC.StartBlock),
		positionManagerABI: positionManagerABI,
	}

	// Log event signatures for debugging
	log.Printf("Event signatures:")
	log.Printf("  PoolCreated: %s", SigPoolCreated.Hex())
	log.Printf("  Swap: %s", SigSwap.Hex())
	log.Printf("  Mint: %s", SigMint.Hex())
	log.Printf("  Burn: %s", SigBurn.Hex())
	log.Printf("  Transfer: %s", SigTransfer.Hex())
	log.Printf("PoolManager address: %s", config.Contracts.PoolManager)

	// Load existing pools from DB
	rows, err := db.Query("SELECT address FROM pools")
	if err != nil {
		return nil, fmt.Errorf("failed to load pools: %v", err)
	}
	defer rows.Close()

	for rows.Next() {
		var addr string
		if err := rows.Scan(&addr); err != nil {
			continue
		}
		scanner.Pools[common.HexToAddress(addr)] = true
	}
	log.Printf("Loaded %d pools from database", len(scanner.Pools))

	// 从 indexed_status 表查询扫描高度
	network := getNetworkFromURL(config.RPC.Url)
	var lastBlock sql.NullInt64
	err = db.QueryRow("SELECT last_block FROM indexed_status WHERE network = $1", network).Scan(&lastBlock)
	if err == nil && lastBlock.Valid {
		// 数据库中有记录，使用数据库中的区块高度
		scanner.Current = uint64(lastBlock.Int64) + 1
		log.Printf("Resuming from indexed_status: network=%s, last_block=%d, starting from block %d", network, lastBlock.Int64, scanner.Current)
	} else {
		// 数据库中没有记录，使用配置文件中的 StartBlock
		scanner.Current = uint64(config.RPC.StartBlock)
		log.Printf("No indexed_status found for network=%s, using config StartBlock=%d", network, config.RPC.StartBlock)
	}

	return scanner, nil
}

// Run 启动扫描器的主循环
func (s *Scanner) Run() {
	ticker := time.NewTicker(12 * time.Second)
	defer ticker.Stop()

	for {
		header, err := s.Client.HeaderByNumber(context.Background(), nil)
		if err != nil {
			log.Printf("Failed to get latest block: %v", err)
			time.Sleep(5 * time.Second)
			continue
		}

		latestBlock := header.Number.Uint64()
		if s.Current > latestBlock {
			log.Printf("Synced to head (%d). Waiting for new blocks...", latestBlock)
			<-ticker.C
			continue
		}

		// Sync in chunks
		end := s.Current + 1000
		if end > latestBlock {
			end = latestBlock
		}

		log.Printf("Scanning range %d - %d", s.Current, end)
		if err := s.scanRange(s.Current, end); err != nil {
			log.Printf("Error scanning range: %v", err)
			time.Sleep(5 * time.Second)
			continue
		}

		s.Current = end + 1
		// 更新 indexed_status 表
		if err := s.updateIndexedStatus(end); err != nil {
			log.Printf("Failed to update indexed_status: %v", err)
		}
	}
}

// scanRange 扫描指定区块范围内的事件
func (s *Scanner) scanRange(start, end uint64) error {
	ctx := context.Background()
	poolManagerAddr := common.HexToAddress(s.Config.Contracts.PoolManager)
	positionManagerAddr := common.HexToAddress(s.Config.Contracts.PositionManager)

	// 公共 RPC（Infura / publicnode 等）禁止「不带 address 的 eth_getLogs」，
	// 因此改为按合约地址分别查询。先扫 PoolManager 的 PoolCreated，
	// 这样能在「同一扫描区间」内及时发现新池并继续扫 Swap/Mint/Burn。

	// 1) PoolCreated 来自 PoolManager
	poolLogs, err := s.Client.FilterLogs(ctx, ethereum.FilterQuery{
		FromBlock: big.NewInt(int64(start)),
		ToBlock:   big.NewInt(int64(end)),
		Addresses: []common.Address{poolManagerAddr},
		Topics:    [][]common.Hash{{SigPoolCreated}},
	})
	if err != nil {
		return err
	}
	for _, vLog := range poolLogs {
		s.handlePoolCreated(vLog)
	}

	// 2) Transfer（NFT mint/burn）来自 PositionManager
	transferLogs, err := s.Client.FilterLogs(ctx, ethereum.FilterQuery{
		FromBlock: big.NewInt(int64(start)),
		ToBlock:   big.NewInt(int64(end)),
		Addresses: []common.Address{positionManagerAddr},
		Topics:    [][]common.Hash{{SigTransfer}},
	})
	if err != nil {
		return err
	}
	transferCount := 0
	for _, vLog := range transferLogs {
		if len(vLog.Topics) >= 4 {
			transferCount++
			log.Printf("Found PositionManager Transfer event: tx=%s, block=%d",
				vLog.TxHash.Hex(), vLog.BlockNumber)
			s.handlePositionTransfer(vLog)
		}
	}

	// 3) Swap / Mint / Burn 来自各个已知池（s.Pools 已由上面的 PoolCreated 更新）
	poolAddrs := make([]common.Address, 0, len(s.Pools))
	for addr := range s.Pools {
		poolAddrs = append(poolAddrs, addr)
	}
	eventCount := 0
	if len(poolAddrs) > 0 {
		poolEventLogs, err := s.Client.FilterLogs(ctx, ethereum.FilterQuery{
			FromBlock: big.NewInt(int64(start)),
			ToBlock:   big.NewInt(int64(end)),
			Addresses: poolAddrs,
			Topics:    [][]common.Hash{{SigSwap, SigMint, SigBurn}},
		})
		if err != nil {
			return err
		}
		for _, vLog := range poolEventLogs {
			if !s.Pools[vLog.Address] {
				s.ensurePoolExists(vLog.Address)
			}
			if !s.Pools[vLog.Address] {
				continue
			}
			switch vLog.Topics[0] {
			case SigSwap:
				s.handleSwap(vLog)
				eventCount++
			case SigMint:
				s.handleMint(vLog)
				eventCount++
			case SigBurn:
				s.handleBurn(vLog)
				eventCount++
			}
		}
	}

	if transferCount > 0 || eventCount > 0 || len(poolLogs) > 0 {
		log.Printf("Processed events in range %d-%d (PoolCreated=%d, Transfer=%d, poolEvents=%d)",
			start, end, len(poolLogs), transferCount, eventCount)
	}
	if transferCount == 0 {
		log.Printf("WARNING: No PositionManager Transfer events found. " +
			"Positions table will be empty if liquidity was added via TestLP (not PositionManager)")
	}
	return nil
}

// getNetworkFromURL 从 RPC URL 推断网络标识
func getNetworkFromURL(url string) string {
	urlLower := strings.ToLower(url)
	if strings.Contains(urlLower, "localhost") || strings.Contains(urlLower, "127.0.0.1") {
		return "local"
	}
	if strings.Contains(urlLower, "sepolia") {
		return "sepolia"
	}
	if strings.Contains(urlLower, "goerli") {
		return "goerli"
	}
	if strings.Contains(urlLower, "mainnet") || strings.Contains(urlLower, "eth-mainnet") {
		return "mainnet"
	}
	// 默认使用 URL 的 hostname 作为网络标识
	// 如果无法推断，使用 "default"
	return "default"
}

// updateIndexedStatus 更新 indexed_status 表中的扫描高度
func (s *Scanner) updateIndexedStatus(blockNumber uint64) error {
	network := getNetworkFromURL(s.Config.RPC.Url)
	_, err := s.DB.Exec(
		`INSERT INTO indexed_status (network, last_block, updated_at) 
		 VALUES ($1, $2, NOW()) 
		 ON CONFLICT (network) 
		 DO UPDATE SET last_block = $2, updated_at = NOW()`,
		network, blockNumber,
	)
	return err
}
