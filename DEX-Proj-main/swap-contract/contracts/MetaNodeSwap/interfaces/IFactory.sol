// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @title IFactory
/// @notice 工厂合约接口：定义池子创建、查询及参数传递的标准。
interface IFactory {
    /// @notice 创建池子时临时存放的参数结构体。
    /// @dev Pool 构造函数通过读取 Factory 的 parameters 获取这些值（因 CREATE2 需固定 initcode）。
    struct Parameters {
        address factory;    // 工厂合约地址
        address tokenA;     // 代币 A
        address tokenB;     // 代币 B
        int24 tickLower;    // 价格区间下界
        int24 tickUpper;    // 价格区间上界
        uint24 fee;         // 手续费率
    }

    /// @notice 读取当前暂存的池子创建参数。
    /// @return factory 工厂地址
    /// @return tokenA 代币 A
    /// @return tokenB 代币 B
    /// @return tickLower 价格区间下界
    /// @return tickUpper 价格区间上界
    /// @return fee 手续费率
    function parameters()
        external
        view
        returns (
            address factory,
            address tokenA,
            address tokenB,
            int24 tickLower,
            int24 tickUpper,
            uint24 fee
        );

    /// @notice 池子创建事件。
    /// @param token0 排序后的代币 0
    /// @param token1 排序后的代币 1
    /// @param index 该交易对下的池子索引
    /// @param tickLower 价格区间下界
    /// @param tickUpper 价格区间上界
    /// @param fee 手续费率
    /// @param pool 新创建的池子地址
    event PoolCreated(
        address token0,
        address token1,
        uint32 index,
        int24 tickLower,
        int24 tickUpper,
        uint24 fee,
        address pool
    );

    /// @notice 根据代币对和索引查询池子地址。
    /// @param tokenA 代币 A
    /// @param tokenB 代币 B
    /// @param index 池子索引（从 0 开始）
    /// @return pool 池子合约地址
    function getPool(
        address tokenA,
        address tokenB,
        uint32 index
    ) external view returns (address pool);

    /// @notice 创建新的流动性池。
    /// @param tokenA 代币 A
    /// @param tokenB 代币 B
    /// @param tickLower 价格区间下界
    /// @param tickUpper 价格区间上界
    /// @param fee 手续费率
    /// @return pool 新创建的池子地址
    function createPool(
        address tokenA,
        address tokenB,
        int24 tickLower,
        int24 tickUpper,
        uint24 fee
    ) external returns (address pool);
}
