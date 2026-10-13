// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;
pragma abicoder v2;

import "./IFactory.sol";

/// @title IPoolManager
/// @notice 池子管理器接口：在 Factory 基础上增加交易对列表、全量池子查询及一键创建并初始化池子的能力。
interface IPoolManager is IFactory {
    /// @notice 池子信息结构体，用于前端展示或路由计算。
    struct PoolInfo {
        address pool;           // 池子合约地址
        address token0;         // 代币 0
        address token1;         // 代币 1
        uint32 index;           // 该交易对下的池子索引
        uint24 fee;             // 手续费率
        uint8 feeProtocol;      // 协议手续费比例（当前未使用）
        int24 tickLower;        // 价格区间下界
        int24 tickUpper;        // 价格区间上界
        int24 tick;             // 当前 tick
        uint160 sqrtPriceX96;   // 当前价格平方根（Q64.96）
        uint128 liquidity;      // 当前流动性
    }

    /// @notice 交易对结构体。
    struct Pair {
        address token0; // 代币 0
        address token1; // 代币 1
    }

    /// @notice 返回所有已登记的交易对列表。
    /// @return 交易对数组
    function getPairs() external view returns (Pair[] memory);

    /// @notice 返回所有池子的汇总信息。
    /// @return poolsInfo 池子信息数组
    function getAllPools() external view returns (PoolInfo[] memory poolsInfo);

    /// @notice 创建并初始化池子的参数结构体。
    struct CreateAndInitializeParams {
        address token0;         // 代币 0
        address token1;         // 代币 1
        uint24 fee;             // 手续费率
        int24 tickLower;        // 价格区间下界
        int24 tickUpper;        // 价格区间上界
        uint160 sqrtPriceX96;   // 初始价格平方根（Q64.96）
    }

    /// @notice 若池子不存在则创建，若未初始化则设初始价格；首次为该交易对建池时记录交易对。
    /// @param params 创建/初始化参数
    /// @return pool 池子地址
    function createAndInitializePoolIfNecessary(
        CreateAndInitializeParams calldata params
    ) external payable returns (address pool);
}
