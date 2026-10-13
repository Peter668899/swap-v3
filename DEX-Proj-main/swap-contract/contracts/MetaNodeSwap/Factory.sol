// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IFactory.sol";
import "./Pool.sol";

/// @title Factory
/// @notice 工厂合约：负责按「代币对 + 价格区间 + 手续费」创建并登记流动性池。
/// @dev 同一代币对可存在多个池子（不同 tickLower/tickUpper/fee），通过 index 区分；使用 CREATE2 保证池子地址可预测。
contract Factory is IFactory {
    /// @notice 代币对 -> 该交易对下所有池子地址列表。token0 < token1 为规范顺序。
    mapping(address => mapping(address => address[])) public pools;

    /// @notice 创建池子时临时存放参数，供 Pool 构造函数从工厂读取（因 CREATE2 需固定 initcode 才能定址）。
    Parameters public override parameters;

    /// @notice 将两代币按地址大小排序，保证 token0 < token1，避免同一交易对重复建池。
    function sortToken(
        address tokenA,
        address tokenB
    ) private pure returns (address, address) {
        return tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    /// @notice 根据代币对和池子索引查询池子地址。
    /// @param tokenA 代币 A
    /// @param tokenB 代币 B
    /// @param index 该交易对下第几个池子（从 0 起）
    function getPool(
        address tokenA,
        address tokenB,
        uint32 index
    ) external view override returns (address) {
        require(tokenA != tokenB, "IDENTICAL_ADDRESSES");
        require(tokenA != address(0) && tokenB != address(0), "ZERO_ADDRESS");

        // 声明 token0 和 token1 变量
        address token0;
        address token1;

        (token0, token1) = sortToken(tokenA, tokenB);

        return pools[token0][token1][index];
    }

    /// @notice 创建或复用流动性池。同一 (token0, token1, tickLower, tickUpper, fee) 仅会有一个池子，重复创建返回已存在池子地址。
    /// @param tokenA 代币 A
    /// @param tokenB 代币 B
    /// @param tickLower 价格区间下界（tick）
    /// @param tickUpper 价格区间上界（tick）
    /// @param fee 手续费率（如 3000 表示 0.3%）
    /// @return pool 新创建或已存在的 Pool 合约地址
    function createPool(
        address tokenA,
        address tokenB,
        int24 tickLower,
        int24 tickUpper,
        uint24 fee
    ) external override returns (address pool) {
        // 校验代币地址不能相同
        require(tokenA != tokenB, "IDENTICAL_ADDRESSES");

        // 声明 token0 和 token1 变量
        address token0;
        address token1;

        // 排序代币，避免顺序错误
        (token0, token1) = sortToken(tokenA, tokenB);

        // 获取当前该交易对下的所有池子
        address[] memory existingPools = pools[token0][token1];

        // 检查该池子是否已存在（相同 tickLower、tickUpper、fee）
        for (uint256 i = 0; i < existingPools.length; i++) {
            IPool currentPool = IPool(existingPools[i]);

            if (
                currentPool.tickLower() == tickLower &&
                currentPool.tickUpper() == tickUpper &&
                currentPool.fee() == fee
            ) {
                return existingPools[i];
            }
        }

        // 保存池子参数到临时存储，供 Pool 构造函数读取
        parameters = Parameters(
            address(this),
            token0,
            token1,
            tickLower,
            tickUpper,
            fee
        );

        // 生成 CREATE2 的 salt 值，确保相同参数产生相同地址
        bytes32 salt = keccak256(
            abi.encode(token0, token1, tickLower, tickUpper, fee)
        );

        // 使用 CREATE2 创建新 Pool 合约
        pool = address(new Pool{salt: salt}());

        // 将新创建的池子地址加入列表
        pools[token0][token1].push(pool);

        // 清除临时参数
        delete parameters;

        emit PoolCreated(
            token0,
            token1,
            uint32(existingPools.length),
            tickLower,
            tickUpper,
            fee,
            pool
        );
    }
}
