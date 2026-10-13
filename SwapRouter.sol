// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import "./interfaces/ISwapRouter.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IPoolManager.sol";
import "./interfaces/IWETH9.sol";
import "./libraries/TransferHelper.sol";
import "./base/Multicall.sol";

/// @title SwapRouter
/// @notice 兑换路由合约：面向用户提供「精确输入」「精确输出」兑换接口，支持按 indexPath 在多个池子中顺序成交；并实现 Pool 的 swap 回调，从用户转入输入代币。
/// @dev 报价接口 quoteExactInput/quoteExactOutput 通过故意 revert 携带 (amount0, amount1) 供链下解析，调用前需理解其 revert 语义。
contract SwapRouter is ISwapRouter, Multicall {
    /// @notice 池子管理器，用于根据 (tokenIn, tokenOut, index) 解析池子并执行 swap。
    IPoolManager public poolManager;
    /// @notice WETH9 合约地址，用于 ETH/WETH 包装与解包。
    address public immutable WETH9;

    constructor(address _poolManager, address _weth9) {
        poolManager = IPoolManager(_poolManager);
        WETH9 = _weth9;
    }

    receive() external payable {
        require(msg.sender == WETH9, "Not WETH9");
    }

    function multicall(
        bytes[] calldata data
    )
        public
        payable
        override(ISwapRouter, Multicall)
        returns (bytes[] memory results)
    {
        return super.multicall(data);
    }

    function wrapETH() external payable override {
        require(msg.value > 0, "No ETH");
        IWETH9(WETH9).deposit{value: msg.value}();
    }

    function unwrapWETH9(
        uint256 amountMinimum,
        address recipient
    ) external payable override {
        require(recipient != address(0), "Invalid recipient");
        uint256 balanceWETH = IERC20(WETH9).balanceOf(address(this));
        require(balanceWETH >= amountMinimum, "Insufficient WETH9");
        if (balanceWETH > 0) {
            IWETH9(WETH9).withdraw(balanceWETH);
            TransferHelper.safeTransferETH(recipient, balanceWETH);
        }
    }

    function refundETH() external payable override {
        if (address(this).balance > 0) {
            TransferHelper.safeTransferETH(msg.sender, address(this).balance);
        }
    }

    function sweepToken(
        address token,
        uint256 amountMinimum,
        address recipient
    ) external payable override {
        require(recipient != address(0), "Invalid recipient");
        uint256 balanceToken = IERC20(token).balanceOf(address(this));
        require(balanceToken >= amountMinimum, "Insufficient token");
        if (balanceToken > 0) {
            TransferHelper.safeTransfer(token, recipient, balanceToken);
        }
    }

    function selfPermit(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable override {
        IERC20Permit(token).permit(
            msg.sender,
            address(this),
            value,
            deadline,
            v,
            r,
            s
        );
    }

    function selfPermitIfNecessary(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable override {
        if (IERC20(token).allowance(msg.sender, address(this)) < value) {
            IERC20Permit(token).permit(
                msg.sender,
                address(this),
                value,
                deadline,
                v,
                r,
                s
            );
        }
    }

    function _resolvePayer(
        address tokenIn,
        address recipient
    ) private view returns (address payer) {
        if (recipient == address(0)) {
            return address(0);
        }
        if (tokenIn == WETH9 && msg.value > 0) {
            // multicall 场景下，允许先 wrapETH 后直接由 Router 支付 WETH。
            return address(this);
        }
        return msg.sender;
    }

    /// @dev 解析报价 revert 中的 (amount0, amount1)，用于 quote 类接口的链下解析。
    function parseRevertReason(
        bytes memory reason
    ) private pure returns (int256, int256) {
        if (reason.length != 64) {
            if (reason.length < 68) revert("Unexpected error");
            assembly {
                reason := add(reason, 0x04)
            }
            revert(abi.decode(reason, (string)));
        }
        return abi.decode(reason, (int256, int256));
    }

    /// @notice 在单个池子内执行一次 swap，并捕获 revert 以解析报价结果（供 quote 使用）。
    function swapInPool(
        IPool pool,
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1) {
        try
            pool.swap(
                recipient,
                zeroForOne,
                amountSpecified,
                sqrtPriceLimitX96,
                data
            )
        returns (int256 _amount0, int256 _amount1) {
            return (_amount0, _amount1);
        } catch (bytes memory reason) {
            return parseRevertReason(reason);
        }
    }

    /// @dev 在单个池子中执行一次 swap。
    ///      通过 swapInPool（external self-call）调用 Pool.swap，内部 try/catch 捕获 revert 用于 quote 场景。
    ///      data 中编码 (tokenIn, tokenOut, index, payer)，Pool 回调 swapCallback 时解码并完成代币转入。
    function _swapSingle(
        address tokenIn,
        address tokenOut,
        uint32 index,
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        address payer
    ) private returns (int256 amount0, int256 amount1) {
        address poolAddress = poolManager.getPool(tokenIn, tokenOut, index);
        require(poolAddress != address(0), "Pool not found");

        bytes memory data = abi.encode(tokenIn, tokenOut, index, payer);
        return
            this.swapInPool(
                IPool(poolAddress),
                recipient,
                zeroForOne,
                amountSpecified,
                sqrtPriceLimitX96,
                data
            );
    }

    /// @notice 精确输入兑换：指定输入代币数量与最少输出数量，按 indexPath 依次在多个池子中兑换，满足 amountOut >= amountOutMinimum 才成功；用户需对 SwapRouter 授权输入代币。
    /// @param params 包含 tokenIn、tokenOut、indexPath、recipient、amountIn、amountOutMinimum、sqrtPriceLimitX96 等
    /// @return amountOut 实际得到的输出代币数量
    function exactInput(
        ExactInputParams calldata params
    ) external payable override returns (uint256 amountOut) {
        uint256 amountIn = params.amountIn;

        // 根据地址大小确定方向：地址小的是 token0，大的是 token1
        bool zeroForOne = params.tokenIn < params.tokenOut;
        address payer = _resolvePayer(params.tokenIn, params.recipient);

        // 按 indexPath 依次在多个同币对池子中执行 swap，将剩余输入量逐步消耗
        // 每个 index 对应同一代币对的不同池子（可能有不同手续费率或价格区间）
        for (uint256 i = 0; i < params.indexPath.length; i++) {
            (int256 amount0, int256 amount1) = _swapSingle(
                params.tokenIn,
                params.tokenOut,
                params.indexPath[i],
                params.recipient,
                zeroForOne,
                int256(amountIn),
                params.sqrtPriceLimitX96,
                payer
            );

            // amount0/amount1 正值=Pool 流入，负值=Pool 流出
            // zeroForOne 时：amount0 为用户付出的输入量，-amount1 为用户获得的输出量
            amountIn -= uint256(zeroForOne ? amount0 : amount1);
            amountOut += uint256(zeroForOne ? -amount1 : -amount0);

            if (amountIn == 0) {
                break;
            }
        }

        // 滑点保护：输出量不得低于用户设定的最小值
        require(amountOut >= params.amountOutMinimum, "Slippage exceeded");

        emit Swap(msg.sender, zeroForOne, params.amountIn, amountIn, amountOut);

        return amountOut;
    }

    /// @notice 精确输出兑换：指定输出代币数量与最大输入数量，按 indexPath 依次在多个池子中兑换，满足 amountIn <= amountInMaximum 才成功；用户需对 SwapRouter 授权足够输入代币。
    /// @param params 包含 tokenIn、tokenOut、indexPath、recipient、amountOut、amountInMaximum、sqrtPriceLimitX96 等
    /// @return amountIn 实际消耗的输入代币数量
    function exactOutput(
        ExactOutputParams calldata params
    ) external payable override returns (uint256 amountIn) {
        uint256 amountOut = params.amountOut;

        bool zeroForOne = params.tokenIn < params.tokenOut;
        address payer = _resolvePayer(params.tokenIn, params.recipient);

        // 按 indexPath 依次在多个池子中执行 swap，将剩余输出需求逐步满足
        // amountSpecified 传负值表示精确输出模式
        for (uint256 i = 0; i < params.indexPath.length; i++) {
            (int256 amount0, int256 amount1) = _swapSingle(
                params.tokenIn,
                params.tokenOut,
                params.indexPath[i],
                params.recipient,
                zeroForOne,
                -int256(amountOut),
                params.sqrtPriceLimitX96,
                payer
            );

            // 扣减已满足的输出量，累加实际消耗的输入量（含手续费）
            amountOut -= uint256(zeroForOne ? -amount1 : -amount0);
            amountIn += uint256(zeroForOne ? amount0 : amount1);

            if (amountOut == 0) {
                break;
            }
        }

        // 滑点保护：实际输入量不得超过用户设定的最大值
        require(amountIn <= params.amountInMaximum, "Slippage exceeded");

        emit Swap(
            msg.sender,
            zeroForOne,
            params.amountOut,
            amountOut,
            amountIn
        );

        return amountIn;
    }

    /// @notice 报价：指定输入数量，模拟 exactInput 得到输出数量；因 recipient=0 会触发 swapCallback 中 revert 携带 (amount0, amount1)，需在链下用 try/catch 或 staticcall 解析。
    function quoteExactInput(
        QuoteExactInputParams calldata params
    ) external override returns (uint256 amountOut) {
        // 因为没有实际 approve，所以这里交易会报错，我们捕获错误信息，解析需要多少 token

        return
            this.exactInput(
                ExactInputParams({
                    tokenIn: params.tokenIn,
                    tokenOut: params.tokenOut,
                    indexPath: params.indexPath,
                    recipient: address(0),
                    deadline: block.timestamp + 1 hours,
                    amountIn: params.amountIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96
                })
            );
    }

    /// @notice 报价：指定输出数量，模拟 exactOutput 得到所需输入数量；同样通过 revert 返回结果，需链下解析。
    function quoteExactOutput(
        QuoteExactOutputParams calldata params
    ) external override returns (uint256 amountIn) {
        return
            this.exactOutput(
                ExactOutputParams({
                    tokenIn: params.tokenIn,
                    tokenOut: params.tokenOut,
                    indexPath: params.indexPath,
                    recipient: address(0),
                    deadline: block.timestamp + 1 hours,
                    amountOut: params.amountOut,
                    amountInMaximum: type(uint256).max,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96
                })
            );
    }

    /// @notice Pool.swap 的回调，由 Pool 在 swap 过程中调用，用于从用户处收取输入代币。
    /// @dev 支付逻辑按优先级：
    ///      1. payer == address(0) → quote 模式，直接 revert 携带 (amount0, amount1) 供链下解析
    ///      2. payer == Router → 从 Router 自身余额支付（multicall 中先 wrapETH 的场景）
    ///      3. tokenIn 为 WETH9 且 Router 持有足够 ETH → 即时 wrap 后支付
    ///      4. 普通 ERC20 → 从 payer 调用 transferFrom 拉取到 Pool
    function swapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        (address tokenIn, address tokenOut, uint32 index, address payer) = abi
            .decode(data, (address, address, uint32, address));
        address _pool = poolManager.getPool(tokenIn, tokenOut, index);

        require(_pool == msg.sender, "Invalid callback caller");

        // amount0Delta/amount1Delta 正值表示 Pool 需要收取的代币
        uint256 amountToPay = amount0Delta > 0
            ? uint256(amount0Delta)
            : uint256(amount1Delta);

        // ── quote 模式：payer = address(0)，不实际转账，revert 携带结果供调用方 try/catch 解析
        if (payer == address(0)) {
            assembly {
                let ptr := mload(0x40)
                mstore(ptr, amount0Delta)
                mstore(add(ptr, 0x20), amount1Delta)
                revert(ptr, 64)
            }
        }

        if (amountToPay == 0) {
            return;
        }

        // ── Router 自身支付（multicall 中先调用 wrapETH 将 ETH → WETH 存入 Router）
        if (payer == address(this)) {
            TransferHelper.safeTransfer(tokenIn, _pool, amountToPay);
            return;
        }

        // ── ETH 即时包装：Router 持有 ETH 且输入侧为 WETH9
        if (tokenIn == WETH9 && address(this).balance >= amountToPay) {
            IWETH9(WETH9).deposit{value: amountToPay}();
            TransferHelper.safeTransfer(tokenIn, _pool, amountToPay);
            return;
        }

        // ── 普通 ERC20：从用户（payer）拉取 tokenIn 到 Pool（需用户提前 approve Router）
        TransferHelper.safeTransferFrom(tokenIn, payer, _pool, amountToPay);
    }
}
