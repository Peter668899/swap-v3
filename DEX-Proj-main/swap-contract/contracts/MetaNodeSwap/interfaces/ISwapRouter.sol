// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;
pragma abicoder v2;

import "./IPool.sol";

/// @title ISwapRouter
/// @notice 兑换路由接口：定义精确输入/输出兑换、报价及辅助操作（wrap/unwrap/refund/sweep/permit）的标准。
interface ISwapRouter is ISwapCallback {
    /// @notice 兑换事件。
    /// @param sender 调用者
    /// @param zeroForOne 兑换方向
    /// @param amountIn 输入数量
    /// @param amountInRemaining 剩余未消耗的输入数量
    /// @param amountOut 输出数量
    event Swap(
        address indexed sender,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountInRemaining,
        uint256 amountOut
    );

    /// @notice 精确输入兑换参数。
    struct ExactInputParams {
        address tokenIn;                // 输入代币地址
        address tokenOut;               // 输出代币地址
        uint32[] indexPath;             // 池子索引路径（同一代币对可多池顺序成交）
        address recipient;              // 输出代币接收地址
        uint256 deadline;               // 交易截止时间
        uint256 amountIn;               // 输入数量
        uint256 amountOutMinimum;       // 最小输出数量（滑点保护）
        uint160 sqrtPriceLimitX96;      // 价格边界
    }

    /// @notice 精确输入兑换：指定输入数量，按 indexPath 依次在多个池子中兑换。
    /// @param params 兑换参数
    /// @return amountOut 实际得到的输出数量
    function exactInput(
        ExactInputParams calldata params
    ) external payable returns (uint256 amountOut);

    /// @notice 精确输出兑换参数。
    struct ExactOutputParams {
        address tokenIn;                // 输入代币地址
        address tokenOut;               // 输出代币地址
        uint32[] indexPath;             // 池子索引路径
        address recipient;              // 输出代币接收地址
        uint256 deadline;               // 交易截止时间
        uint256 amountOut;              // 期望输出数量
        uint256 amountInMaximum;        // 最大输入数量（滑点保护）
        uint160 sqrtPriceLimitX96;      // 价格边界
    }

    /// @notice 精确输出兑换：指定输出数量，按 indexPath 依次在多个池子中兑换。
    /// @param params 兑换参数
    /// @return amountIn 实际消耗的输入数量
    function exactOutput(
        ExactOutputParams calldata params
    ) external payable returns (uint256 amountIn);

    /// @notice 报价（精确输入）参数。
    struct QuoteExactInputParams {
        address tokenIn;                // 输入代币地址
        address tokenOut;               // 输出代币地址
        uint32[] indexPath;             // 池子索引路径
        uint256 amountIn;               // 输入数量
        uint160 sqrtPriceLimitX96;      // 价格边界
    }

    /// @notice 报价：模拟精确输入兑换，返回输出数量（通过 revert 携带结果）。
    function quoteExactInput(
        QuoteExactInputParams calldata params
    ) external returns (uint256 amountOut);

    /// @notice 报价（精确输出）参数。
    struct QuoteExactOutputParams {
        address tokenIn;                // 输入代币地址
        address tokenOut;               // 输出代币地址
        uint32[] indexPath;             // 池子索引路径
        uint256 amountOut;              // 期望输出数量
        uint160 sqrtPriceLimitX96;      // 价格边界
    }

    /// @notice 报价：模拟精确输出兑换，返回所需输入数量（通过 revert 携带结果）。
    function quoteExactOutput(
        QuoteExactOutputParams calldata params
    ) external returns (uint256 amountIn);

    /// @notice 批量调用 Router 自身方法（Uniswap 风格）：按顺序 delegatecall 执行 data 中的每一项调用数据。
    /// @dev 该方法为 payable，可与需要 ETH/value 的子调用一起使用；返回每个子调用的原始返回值 bytes。
    function multicall(
        bytes[] calldata data
    ) external payable returns (bytes[] memory results);

    /// @notice 将本次调用携带的 ETH 全部包装成 WETH9，WETH 保留在 Router 中，便于后续 multicall 子调用使用。
    function wrapETH() external payable;

    /// @notice 将 Router 持有的全部 WETH9 解包为 ETH 并转给 recipient。
    /// @param amountMinimum 最小解包数量（滑点保护）
    /// @param recipient 接收 ETH 的地址
    function unwrapWETH9(
        uint256 amountMinimum,
        address recipient
    ) external payable;

    /// @notice 将 Router 当前持有的 ETH 退回给调用者。
    function refundETH() external payable;

    /// @notice 将 Router 持有的指定 ERC20 全部转给 recipient。
    /// @param token 代币地址
    /// @param amountMinimum 最小转出数量（滑点保护）
    /// @param recipient 接收代币的地址
    function sweepToken(
        address token,
        uint256 amountMinimum,
        address recipient
    ) external payable;

    /// @notice 使用 EIP-2612 permit 为 Router 授权，无需单独发 approve 交易。
    function selfPermit(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable;

    /// @notice 当 allowance 不足时才执行 permit，避免重复签名/调用。
    function selfPermitIfNecessary(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable;
}
