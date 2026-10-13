// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./libraries/SqrtPriceMath.sol";
import "./libraries/TickMath.sol";
import "./libraries/LiquidityMath.sol";
import "./libraries/LowGasSafeMath.sol";
import "./libraries/SafeCast.sol";
import "./libraries/TransferHelper.sol";
import "./libraries/SwapMath.sol";
import "./libraries/FixedPoint128.sol";

import "./interfaces/IPool.sol";
import "./interfaces/IFactory.sol";

/// @title Pool
/// @notice 单一流动性池：对应一个代币对在一个固定价格区间 [tickLower, tickUpper] 内的流动性，支持在该区间内做市与兑换。
/// @dev 采用集中流动性（Concentrated Liquidity）：当前价格必须在区间内才有有效流动性；提供 mint/burn/swap/collect 等核心操作。
contract Pool is IPool {
    using SafeCast for uint256;
    using LowGasSafeMath for int256;
    using LowGasSafeMath for uint256;

    /// @inheritdoc IPool
    address public immutable override factory;
    /// @inheritdoc IPool
    address public immutable override token0;
    /// @inheritdoc IPool
    address public immutable override token1;
    /// @inheritdoc IPool
    uint24 public immutable override fee;
    /// @inheritdoc IPool
    int24 public immutable override tickLower;
    /// @inheritdoc IPool
    int24 public immutable override tickUpper;

    /// @inheritdoc IPool
    uint160 public override sqrtPriceX96;
    /// @inheritdoc IPool
    int24 public override tick;
    /// @inheritdoc IPool
    uint128 public override liquidity;

    /// @inheritdoc IPool
    /// @dev 全局每单位流动性累积的 token0 手续费，Q128 定点数。
    ///      每次 swap 时按 feeAmount * Q128 / liquidity 递增；LP 的实际手续费 = (当前值 − 快照值) × 自身流动性 / Q128。
    uint256 public override feeGrowthGlobal0X128;
    /// @inheritdoc IPool
    /// @dev 与 feeGrowthGlobal0X128 对称，追踪 token1 侧的手续费增长。
    uint256 public override feeGrowthGlobal1X128;

    struct Position {
        // 该 Position 拥有的流动性
        uint128 liquidity;
        // 可提取的 token0 数量
        uint128 tokensOwed0;
        // 可提取的 token1 数量
        uint128 tokensOwed1;
        // 上次提取手续费时的 feeGrowthGlobal0X128
        uint256 feeGrowthInside0LastX128;
        // 上次提取手续费是的 feeGrowthGlobal1X128
        uint256 feeGrowthInside1LastX128;
    }

    // 用一个 mapping 来存放所有 Position 的信息
    mapping(address => Position) public positions;

    function getPosition(
        address owner
    )
        external
        view
        override
        returns (
            uint128 _liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        return (
            positions[owner].liquidity,
            positions[owner].feeGrowthInside0LastX128,
            positions[owner].feeGrowthInside1LastX128,
            positions[owner].tokensOwed0,
            positions[owner].tokensOwed1
        );
    }

    constructor() {
        // constructor 中初始化 immutable 的常量
        // Factory 创建 Pool 时会通 new Pool{salt: salt}() 的方式创建 Pool 合约，通过 salt 指定 Pool 的地址，这样其他地方也可以推算出 Pool 的地址
        // 参数通过读取 Factory 合约的 parameters 获取
        // 不通过构造函数传入，因为 CREATE2 会根据 initcode 计算出新地址（new_address = hash(0xFF, sender, salt, bytecode)），带上参数就不能计算出稳定的地址了
        (factory, token0, token1, tickLower, tickUpper, fee) = IFactory(
            msg.sender
        ).parameters();
    }

    /// @notice 初始化池子当前价格（仅可调用一次）。价格必须落在 [tickLower, tickUpper) 内，否则无法激活流动性。
    /// @param sqrtPriceX96_ 当前价格的平方根，Q64.96 格式
    function initialize(uint160 sqrtPriceX96_) external override {
        require(sqrtPriceX96 == 0, "INITIALIZED");
        // 通过价格获取 tick，判断 tick 是否在 tickLower 和 tickUpper 之间
        tick = TickMath.getTickAtSqrtPrice(sqrtPriceX96_);
        require(
            tick >= tickLower && tick < tickUpper,
            "sqrtPriceX96 should be within the range of [tickLower, tickUpper)"
        );
        // 初始化 Pool 的 sqrtPriceX96
        sqrtPriceX96 = sqrtPriceX96_;
    }

    struct ModifyPositionParams {
        // the address that owns the position
        address owner;
        // any change in liquidity
        int128 liquidityDelta;
    }

    /// @dev 修改指定 position 的流动性，同时结算该 position 自上次快照以来累积的手续费。
    ///      mint 和 burn 都通过此函数：liquidityDelta > 0 为加流动性，< 0 为减流动性。
    function _modifyPosition(
        ModifyPositionParams memory params
    ) private returns (int256 amount0, int256 amount1) {
        // 根据 liquidityDelta 和当前价格，计算本次操作需要/退还的 token0 与 token1 数量。
        // liquidityDelta > 0 时结果为正（需要转入），< 0 时结果为负（应退还）。
        amount0 = SqrtPriceMath.getAmount0Delta(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickUpper),
            params.liquidityDelta
        );

        amount1 = SqrtPriceMath.getAmount1Delta(
            TickMath.getSqrtPriceAtTick(tickLower),
            sqrtPriceX96,
            params.liquidityDelta
        );
        Position storage position = positions[params.owner];

        // ────────── 手续费结算 ──────────
        // 核心公式：fee = (feeGrowthGlobal − feeGrowthLast) × liquidity / Q128
        //   - feeGrowthGlobal：全局每单位流动性累积手续费（Q128 定点数，每次 swap 时递增）
        //   - feeGrowthLast：该 position 上次快照时的 feeGrowthGlobal 值
        //   - 差值即为自上次快照以来「每单位流动性」新增的手续费
        //   - 乘以该 position 的 liquidity 得到绝对数量，再除以 Q128 还原定点数
        uint128 tokensOwed0 = uint128(
            FullMath.mulDiv(
                feeGrowthGlobal0X128 - position.feeGrowthInside0LastX128,
                position.liquidity,
                FixedPoint128.Q128
            )
        );
        uint128 tokensOwed1 = uint128(
            FullMath.mulDiv(
                feeGrowthGlobal1X128 - position.feeGrowthInside1LastX128,
                position.liquidity,
                FixedPoint128.Q128
            )
        );

        // 快照推进：将 feeGrowthLast 更新到当前全局值，表示截至此刻的手续费已全部结算
        position.feeGrowthInside0LastX128 = feeGrowthGlobal0X128;
        position.feeGrowthInside1LastX128 = feeGrowthGlobal1X128;
        // 将结算出的手续费累加到 tokensOwed，LP 后续通过 collect 提取
        if (tokensOwed0 > 0 || tokensOwed1 > 0) {
            position.tokensOwed0 += tokensOwed0;
            position.tokensOwed1 += tokensOwed1;
        }

        // 更新池子总流动性与该 position 的流动性
        liquidity = LiquidityMath.addDelta(liquidity, params.liquidityDelta);
        position.liquidity = LiquidityMath.addDelta(
            position.liquidity,
            params.liquidityDelta
        );
    }

    /// @dev Get the pool's balance of token0
    /// @dev This function is gas optimized to avoid a redundant extcodesize check in addition to the returndatasize
    /// check
    function balance0() private view returns (uint256) {
        (bool success, bytes memory data) = token0.staticcall(
            abi.encodeWithSelector(IERC20.balanceOf.selector, address(this))
        );
        require(success && data.length >= 32);
        return abi.decode(data, (uint256));
    }

    /// @dev Get the pool's balance of token1
    /// @dev This function is gas optimized to avoid a redundant extcodesize check in addition to the returndatasize
    /// check
    function balance1() private view returns (uint256) {
        (bool success, bytes memory data) = token1.staticcall(
            abi.encodeWithSelector(IERC20.balanceOf.selector, address(this))
        );
        require(success && data.length >= 32);
        return abi.decode(data, (uint256));
    }

    /// @notice 增加流动性：按给定 liquidity 数量向池子注入 token0/token1，并结算至调用前的手续费；由 PositionManager 等外围合约调用，通过 data 回调完成代币转入。
    /// @param recipient 流动性归属地址（position 的 owner）
    /// @param amount 增加的流动性数量
    /// @param data 回调用数据（如 token0/token1/index/payer），用于 mintCallback 中从用户转入代币
    /// @return amount0 本次需要转入的 token0 数量
    /// @return amount1 本次需要转入的 token1 数量
    function mint(
        address recipient,
        uint128 amount,
        bytes calldata data
    ) external override returns (uint256 amount0, uint256 amount1) {
        require(amount > 0, "Mint amount must be greater than 0");
        // 基于 amount 计算出当前需要多少 amount0 和 amount1
        (int256 amount0Int, int256 amount1Int) = _modifyPosition(
            ModifyPositionParams({
                owner: recipient,
                liquidityDelta: int128(amount)
            })
        );
        amount0 = uint256(amount0Int);
        amount1 = uint256(amount1Int);

        uint256 balance0Before;
        uint256 balance1Before;
        if (amount0 > 0) balance0Before = balance0();
        if (amount1 > 0) balance1Before = balance1();
        // 回调 mintCallback
        IMintCallback(msg.sender).mintCallback(amount0, amount1, data);

        if (amount0 > 0)
            require(balance0Before.add(amount0) <= balance0(), "M0");
        if (amount1 > 0)
            require(balance1Before.add(amount1) <= balance1(), "M1");

        emit Mint(msg.sender, recipient, amount, amount0, amount1);
    }

    /// @notice 领取已积累的手续费或 burn 时退出的代币；从 position 的 tokensOwed0/tokensOwed1 中转出至 recipient。
    /// @param recipient 接收代币的地址
    /// @param amount0Requested 希望领取的 token0 数量（实际不超过 tokensOwed0）
    /// @param amount1Requested 希望领取的 token1 数量（实际不超过 tokensOwed1）
    /// @return amount0 实际转出的 token0 数量
    /// @return amount1 实际转出的 token1 数量
    function collect(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external override returns (uint128 amount0, uint128 amount1) {
        // 获取当前用户的 position
        Position storage position = positions[msg.sender];

        // 把钱退给用户 recipient
        amount0 = amount0Requested > position.tokensOwed0
            ? position.tokensOwed0
            : amount0Requested;
        amount1 = amount1Requested > position.tokensOwed1
            ? position.tokensOwed1
            : amount1Requested;

        if (amount0 > 0) {
            position.tokensOwed0 -= amount0;
            TransferHelper.safeTransfer(token0, recipient, amount0);
        }
        if (amount1 > 0) {
            position.tokensOwed1 -= amount1;
            TransferHelper.safeTransfer(token1, recipient, amount1);
        }

        emit Collect(msg.sender, recipient, amount0, amount1);
    }

    /// @notice 减少流动性：销毁指定数量的 liquidity，并按当前价格计算应退的 token0/token1，记入 position 的 tokensOwed，需后续通过 collect 提取。
    /// @param amount 要销毁的流动性数量
    /// @return amount0 本次应退的 token0 数量（已加入 tokensOwed）
    /// @return amount1 本次应退的 token1 数量（已加入 tokensOwed）
    function burn(
        uint128 amount
    ) external override returns (uint256 amount0, uint256 amount1) {
        require(amount > 0, "Burn amount must be greater than 0");
        require(
            amount <= positions[msg.sender].liquidity,
            "Burn amount exceeds liquidity"
        );
        // _modifyPosition 内部先结算手续费（写入 tokensOwed），再减少 liquidity
        (int256 amount0Int, int256 amount1Int) = _modifyPosition(
            ModifyPositionParams({
                owner: msg.sender,
                liquidityDelta: -int128(amount)
            })
        );
        // liquidityDelta 为负 → amount0Int/amount1Int 为负 → 取反得到应退还的代币数量
        amount0 = uint256(-amount0Int);
        amount1 = uint256(-amount1Int);

        // 将 burn 退还的本金也记入 tokensOwed（与手续费合并），统一通过 collect 提取
        if (amount0 > 0 || amount1 > 0) {
            (
                positions[msg.sender].tokensOwed0,
                positions[msg.sender].tokensOwed1
            ) = (
                positions[msg.sender].tokensOwed0 + uint128(amount0),
                positions[msg.sender].tokensOwed1 + uint128(amount1)
            );
        }

        emit Burn(msg.sender, amount, amount0, amount1);
    }

    /// @dev swap 过程中的临时状态，用于在计算完成后一次性写回存储。
    struct SwapState {
        /// 剩余待交换的数量（exactInput 时为正数递减，exactOutput 时为负数递增，归零表示完成）
        int256 amountSpecifiedRemaining;
        /// 已计算出的对手方代币数量（exactInput 时为负的输出量，exactOutput 时为正的输入量）
        int256 amountCalculated;
        /// 当前计算中的 sqrt(price)，swap 结束后写回存储
        uint160 sqrtPriceX96;
        /// 输入侧代币的 feeGrowthGlobal 快照（zeroForOne 取 feeGrowthGlobal0，否则取 feeGrowthGlobal1）
        uint256 feeGrowthGlobalX128;
        /// 本次 swap 中用户实际转入的输入代币数量（不含手续费）
        uint256 amountIn;
        /// 本次 swap 中用户实际获得的输出代币数量
        uint256 amountOut;
        /// 本次 swap 收取的手续费（单位为输入侧代币：zeroForOne 时为 token0，否则为 token1）
        uint256 feeAmount;
    }

    /// @notice 在池子内执行一次兑换：按指定输入/输出数量与价格限制更新池子价格并收取手续费，通过回调转入输入代币、向 recipient 转出输出代币。
    /// @param recipient 接收输出代币的地址
    /// @param zeroForOne true 表示用 token0 换 token1，false 表示用 token1 换 token0
    /// @param amountSpecified 指定数量：>0 表示精确输入（输入 token 数量），<0 表示精确输出（输出 token 数量）
    /// @param sqrtPriceLimitX96 价格边界，防止滑点过大
    /// @param data 回调数据，供 SwapRouter 等识别 payer 并执行 transferFrom
    /// @return amount0 本次兑换导致的 token0 变化（正为流入、负为流出）
    /// @return amount1 本次兑换导致的 token1 变化（正为流入、负为流出）
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external override returns (int256 amount0, int256 amount1) {
        require(amountSpecified != 0, "AS");

        // ────────── 1. 价格限制校验 ──────────
        // zeroForOne = true：用 token0 换 token1，价格下行，sqrtPriceLimitX96 必须 < 当前价格且 > MIN
        // zeroForOne = false：用 token1 换 token0，价格上行，sqrtPriceLimitX96 必须 > 当前价格且 < MAX
        require(
            zeroForOne
                ? sqrtPriceLimitX96 < sqrtPriceX96 &&
                    sqrtPriceLimitX96 > TickMath.MIN_SQRT_PRICE
                : sqrtPriceLimitX96 > sqrtPriceX96 &&
                    sqrtPriceLimitX96 < TickMath.MAX_SQRT_PRICE,
            "SPL"
        );

        // exactInput = true：用户指定输入量（amountSpecified > 0），计算输出
        // exactInput = false：用户指定输出量（amountSpecified < 0），计算输入
        bool exactInput = amountSpecified > 0;

        // ────────── 2. 初始化 swap 临时状态 ──────────
        SwapState memory state = SwapState({
            amountSpecifiedRemaining: amountSpecified,
            amountCalculated: 0,
            sqrtPriceX96: sqrtPriceX96,
            // 取输入侧代币的 feeGrowthGlobal 快照，swap 结束后写回
            feeGrowthGlobalX128: zeroForOne
                ? feeGrowthGlobal0X128
                : feeGrowthGlobal1X128,
            amountIn: 0,
            amountOut: 0,
            feeAmount: 0
        });

        // ────────── 3. 确定价格边界 ──────────
        uint160 sqrtPriceX96Lower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtPriceX96Upper = TickMath.getSqrtPriceAtTick(tickUpper);
        // 池子本身的价格边界：zeroForOne 时价格下行不能低于 tickLower，反之不能高于 tickUpper
        uint160 sqrtPriceX96PoolLimit = zeroForOne
            ? sqrtPriceX96Lower
            : sqrtPriceX96Upper;

        // ────────── 4. 计算 swap 具体数值 ──────────
        // 取用户限价 sqrtPriceLimitX96 和池子边界 sqrtPriceX96PoolLimit 中更保守的一个作为目标价格
        (
            state.sqrtPriceX96,
            state.amountIn,
            state.amountOut,
            state.feeAmount
        ) = SwapMath.computeSwapStep(
            sqrtPriceX96,
            (
                zeroForOne
                    ? sqrtPriceX96PoolLimit < sqrtPriceLimitX96
                    : sqrtPriceX96PoolLimit > sqrtPriceLimitX96
            )
                ? sqrtPriceLimitX96
                : sqrtPriceX96PoolLimit,
            liquidity,
            amountSpecified,
            fee
        );

        // ────────── 5. 更新池子价格 ──────────
        sqrtPriceX96 = state.sqrtPriceX96;
        tick = TickMath.getTickAtSqrtPrice(state.sqrtPriceX96);

        // ────────── 6. 累积手续费到全局 feeGrowthGlobal ──────────
        // 公式：feeGrowthGlobal += feeAmount × Q128 / liquidity
        // 含义：将本次收取的手续费（feeAmount）均摊到每单位流动性上（Q128 定点数表示）
        // LP 领取手续费时用 (feeGrowthGlobal − feeGrowthLast) × 自身liquidity / Q128 反算出应得数量
        state.feeGrowthGlobalX128 += FullMath.mulDiv(
            state.feeAmount,
            FixedPoint128.Q128,
            liquidity
        );

        // 将计算结果写回对应侧的全局存储
        if (zeroForOne) {
            feeGrowthGlobal0X128 = state.feeGrowthGlobalX128;
        } else {
            feeGrowthGlobal1X128 = state.feeGrowthGlobalX128;
        }

        // ────────── 7. 结算 amountSpecifiedRemaining 和 amountCalculated ──────────
        if (exactInput) {
            // 精确输入：从剩余输入中扣减已消耗量（amountIn + feeAmount）
            state.amountSpecifiedRemaining -= (state.amountIn + state.feeAmount)
                .toInt256();
            // amountCalculated 累减输出量（用负数表示流出）
            state.amountCalculated = state.amountCalculated.sub(
                state.amountOut.toInt256()
            );
        } else {
            // 精确输出：从剩余输出需求中累加已满足的输出量
            state.amountSpecifiedRemaining += state.amountOut.toInt256();
            // amountCalculated 累加用户需付的输入量（amountIn + fee）
            state.amountCalculated = state.amountCalculated.add(
                (state.amountIn + state.feeAmount).toInt256()
            );
        }

        // ────────── 8. 推导最终的 amount0 / amount1 ──────────
        // 规则：正值 = Pool 净流入（用户付出），负值 = Pool 净流出（用户收到）
        (amount0, amount1) = zeroForOne == exactInput
            ? (
                amountSpecified - state.amountSpecifiedRemaining,
                state.amountCalculated
            )
            : (
                state.amountCalculated,
                amountSpecified - state.amountSpecifiedRemaining
            );

        // ────────── 9. 执行代币转移 ──────────
        if (zeroForOne) {
            // 用户付 token0：通过回调从用户拉取 token0，校验余额增加
            uint256 balance0Before = balance0();
            ISwapCallback(msg.sender).swapCallback(amount0, amount1, data);
            require(balance0Before.add(uint256(amount0)) <= balance0(), "IIA");

            // Pool 付 token1 给用户
            if (amount1 < 0)
                TransferHelper.safeTransfer(
                    token1,
                    recipient,
                    uint256(-amount1)
                );
        } else {
            // 用户付 token1：通过回调从用户拉取 token1，校验余额增加
            uint256 balance1Before = balance1();
            ISwapCallback(msg.sender).swapCallback(amount0, amount1, data);
            require(balance1Before.add(uint256(amount1)) <= balance1(), "IIA");

            // Pool 付 token0 给用户
            if (amount0 < 0)
                TransferHelper.safeTransfer(
                    token0,
                    recipient,
                    uint256(-amount0)
                );
        }

        emit Swap(
            msg.sender,
            recipient,
            amount0,
            amount1,
            sqrtPriceX96,
            liquidity,
            tick
        );
    }
}
