// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @title IMintCallback
/// @notice mint 回调接口：Pool.mint 调用后回调此接口，由调用方（如 PositionManager）负责转入代币。
interface IMintCallback {
    /// @notice Pool.mint 的回调函数。
    /// @param amount0Owed 需要转入的 token0 数量
    /// @param amount1Owed 需要转入的 token1 数量
    /// @param data 调用方传入的附加数据（如 payer 地址等）
    function mintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external;
}

/// @title ISwapCallback
/// @notice swap 回调接口：Pool.swap 调用后回调此接口，由调用方（如 SwapRouter）负责转入输入代币。
interface ISwapCallback {
    /// @notice Pool.swap 的回调函数。
    /// @param amount0Delta token0 的变化量（正=Pool 应收，负=Pool 应付）
    /// @param amount1Delta token1 的变化量（正=Pool 应收，负=Pool 应付）
    /// @param data 调用方传入的附加数据（如 payer 地址等）
    function swapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external;
}

/// @title IPool
/// @notice 流动性池接口：定义集中流动性池的核心操作（mint/burn/swap/collect）及状态查询。
interface IPool {
    /// @return 工厂合约地址
    function factory() external view returns (address);

    /// @return 代币 0 地址（地址较小的代币）
    function token0() external view returns (address);

    /// @return 代币 1 地址（地址较大的代币）
    function token1() external view returns (address);

    /// @return 手续费率（如 3000 表示 0.3%）
    function fee() external view returns (uint24);

    /// @return 价格区间下界 tick
    function tickLower() external view returns (int24);

    /// @return 价格区间上界 tick
    function tickUpper() external view returns (int24);

    /// @return 当前价格的平方根（Q64.96 定点数）
    function sqrtPriceX96() external view returns (uint160);

    /// @return 当前价格对应的 tick
    function tick() external view returns (int24);

    /// @return 当前池子中有效的总流动性
    function liquidity() external view returns (uint128);

    /// @notice 初始化池子价格（仅可调用一次）。
    /// @param sqrtPriceX96 初始价格的平方根（Q64.96）
    function initialize(uint160 sqrtPriceX96) external;

    /// @notice 全局每单位流动性累积的 token0 手续费（Q128.128 定点数）。
    /// @dev 每次 swap 时递增，LP 通过 (当前值 − 快照值) × 自身流动性 / Q128 计算应得手续费。
    function feeGrowthGlobal0X128() external view returns (uint256);

    /// @notice 全局每单位流动性累积的 token1 手续费（Q128.128 定点数）。
    function feeGrowthGlobal1X128() external view returns (uint256);

    /// @notice 查询指定 owner 的头寸信息。
    /// @param owner 头寸持有者地址
    /// @return _liquidity 头寸流动性
    /// @return feeGrowthInside0LastX128 token0 手续费快照
    /// @return feeGrowthInside1LastX128 token1 手续费快照
    /// @return tokensOwed0 待领 token0
    /// @return tokensOwed1 待领 token1
    function getPosition(
        address owner
    )
        external
        view
        returns (
            uint128 _liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    /// @notice 增加流动性事件。
    event Mint(
        address sender,
        address indexed owner,
        uint128 amount,
        uint256 amount0,
        uint256 amount1
    );

    /// @notice 增加流动性。
    /// @param recipient 流动性归属地址
    /// @param amount 增加的流动性数量
    /// @param data 回调数据
    /// @return amount0 需要转入的 token0 数量
    /// @return amount1 需要转入的 token1 数量
    function mint(
        address recipient,
        uint128 amount,
        bytes calldata data
    ) external returns (uint256 amount0, uint256 amount1);

    /// @notice 领取代币事件。
    event Collect(
        address indexed owner,
        address recipient,
        uint128 amount0,
        uint128 amount1
    );

    /// @notice 领取已积累的手续费或 burn 退出的代币。
    /// @param recipient 接收代币的地址
    /// @param amount0Requested 希望领取的 token0 数量
    /// @param amount1Requested 希望领取的 token1 数量
    /// @return amount0 实际转出的 token0 数量
    /// @return amount1 实际转出的 token1 数量
    function collect(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external returns (uint128 amount0, uint128 amount1);

    /// @notice 销毁流动性事件。
    event Burn(
        address indexed owner,
        uint128 amount,
        uint256 amount0,
        uint256 amount1
    );

    /// @notice 减少流动性。
    /// @param amount 要销毁的流动性数量
    /// @return amount0 应退的 token0 数量
    /// @return amount1 应退的 token1 数量
    function burn(
        uint128 amount
    ) external returns (uint256 amount0, uint256 amount1);

    /// @notice 兑换事件。
    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );

    /// @notice 执行一次兑换。
    /// @param recipient 接收输出代币的地址
    /// @param zeroForOne true=用 token0 换 token1
    /// @param amountSpecified 指定数量（正=精确输入，负=精确输出）
    /// @param sqrtPriceLimitX96 价格边界
    /// @param data 回调数据
    /// @return amount0 token0 变化量
    /// @return amount1 token1 变化量
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}
