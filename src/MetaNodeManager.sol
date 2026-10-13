// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import "./interfaces/IPoolManager.sol";
import "./interfaces/IPositionManager.sol";
import "./interfaces/ISwapRouter.sol";
import "./libraries/TransferHelper.sol";

/// @title MetaNodeManager
/// @notice 聚合入口：在一笔交易内顺序执行建池、加流动性、可选兑换。
/// @dev 该合约不托管资金；流程中临时持有的代币会在函数尾部退回调用者。
contract MetaNodeManager {
    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    ISwapRouter public immutable swapRouter;

    constructor(
        address _poolManager,
        address _positionManager,
        address _swapRouter
    ) {
        poolManager = IPoolManager(_poolManager);
        positionManager = IPositionManager(_positionManager);
        swapRouter = ISwapRouter(_swapRouter);
    }

    struct ExecuteParams {
        IPoolManager.CreateAndInitializeParams poolParams;
        IPositionManager.MintParams mintParams;
        bool executeSwap;
        ISwapRouter.ExactInputParams swapParams;
    }

    /// @notice Manager 自身 multicall：允许前端自由组合 create/add/remove/swap 等原子方法。
    /// @dev 仅 delegatecall 到当前合约，保持 msg.sender/msg.value 语义。
    function multicall(
        bytes[] calldata data
    ) external payable returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool success, bytes memory result) = address(this).delegatecall(
                data[i]
            );
            if (!success) {
                assembly {
                    revert(add(result, 0x20), mload(result))
                }
            }
            results[i] = result;
        }
    }

    /// @notice 一步执行：创建/初始化池子 -> 注入流动性 -> 可选 exactInput 兑换。
    /// @param params 聚合参数（建池参数、加流动性参数、可选兑换参数）
    /// @return poolAddress 池子地址
    /// @return positionId 新建头寸 NFT id
    /// @return liquidity 注入得到的流动性
    /// @return amount0Used 实际使用 token0 数量
    /// @return amount1Used 实际使用 token1 数量
    /// @return amountOut 可选兑换得到的输出数量（不执行兑换则为 0）
    function execute(
        ExecuteParams calldata params
    )
        external
        payable
        returns (
            address poolAddress,
            uint256 positionId,
            uint128 liquidity,
            uint256 amount0Used,
            uint256 amount1Used,
            uint256 amountOut
        )
    {
        (poolAddress, ) = createPool(params.poolParams);
        (positionId, liquidity, amount0Used, amount1Used) = createAndAddLiquidity(
            params.poolParams,
            params.mintParams
        );
        if (params.executeSwap) {
            amountOut = swapExactInput(params.swapParams);
        }
        // 统一退款，避免残余资产留在 manager
        _refundToken(params.mintParams.token0, msg.sender);
        _refundToken(params.mintParams.token1, msg.sender);
        if (params.executeSwap) _refundToken(params.swapParams.tokenIn, msg.sender);
    }

    /// @notice 创建/初始化池子并返回池地址与 index。
    function createPool(
        IPoolManager.CreateAndInitializeParams calldata poolParams
    ) public payable returns (address poolAddress, uint32 index) {
        poolAddress = poolManager.createAndInitializePoolIfNecessary(poolParams);
        index = _resolvePoolIndex(poolParams.token0, poolParams.token1, poolAddress);
    }

    /// @notice 按传入 index 注入流动性（资金中转由 Manager 处理，核心逻辑在 PositionManager）。
    function addLiquidity(
        IPositionManager.MintParams memory mintParams
    )
        public
        payable
        returns (
            uint256 positionId,
            uint128 liquidity,
            uint256 amount0Used,
            uint256 amount1Used
        )
    {
        _pullToken(mintParams.token0, msg.sender, mintParams.amount0Desired);
        _pullToken(mintParams.token1, msg.sender, mintParams.amount1Desired);
        _approveIfNeeded(
            mintParams.token0,
            address(positionManager),
            mintParams.amount0Desired
        );
        _approveIfNeeded(
            mintParams.token1,
            address(positionManager),
            mintParams.amount1Desired
        );

        (positionId, liquidity, amount0Used, amount1Used) = positionManager
            .addLiquidity(mintParams);
        _refundToken(mintParams.token0, msg.sender);
        _refundToken(mintParams.token1, msg.sender);
    }

    /// @notice 创建/初始化池子后立即注入流动性（核心逻辑下沉至 PositionManager）。
    function createAndAddLiquidity(
        IPoolManager.CreateAndInitializeParams calldata poolParams,
        IPositionManager.MintParams calldata mintParams
    )
        public
        payable
        returns (
            uint256 positionId,
            uint128 liquidity,
            uint256 amount0Used,
            uint256 amount1Used
        )
    {
        _pullToken(mintParams.token0, msg.sender, mintParams.amount0Desired);
        _pullToken(mintParams.token1, msg.sender, mintParams.amount1Desired);
        _approveIfNeeded(
            mintParams.token0,
            address(positionManager),
            mintParams.amount0Desired
        );
        _approveIfNeeded(
            mintParams.token1,
            address(positionManager),
            mintParams.amount1Desired
        );
        (positionId, liquidity, amount0Used, amount1Used) = positionManager
            .createAndAddLiquidity(poolParams, mintParams);
        _refundToken(mintParams.token0, msg.sender);
        _refundToken(mintParams.token1, msg.sender);
    }

    /// @notice 移除流动性，可选立即 collect 到 recipient。
    function removeLiquidity(
        uint256 positionId,
        address recipient,
        bool collectAfterBurn
    ) external payable returns (uint256 amount0, uint256 amount1) {
        return
            positionManager.removeLiquidity(
                positionId,
                recipient,
                collectAfterBurn
            );
    }

    /// @notice 领取头寸代币/手续费到指定地址。
    function collectLiquidity(
        uint256 positionId,
        address recipient
    ) external payable returns (uint256 amount0, uint256 amount1) {
        return positionManager.collectLiquidity(positionId, recipient);
    }

    /// @notice 代理调用 SwapRouter.exactInput，并自动处理 tokenIn 拉取与授权。
    function swapExactInput(
        ISwapRouter.ExactInputParams calldata swapParams
    ) public payable returns (uint256 amountOut) {
        _pullToken(swapParams.tokenIn, msg.sender, swapParams.amountIn);
        _approveIfNeeded(
            swapParams.tokenIn,
            address(swapRouter),
            swapParams.amountIn
        );
        amountOut = swapRouter.exactInput{value: msg.value}(swapParams);
        _refundToken(swapParams.tokenIn, msg.sender);
    }

    /// @notice 代理调用 SwapRouter.exactOutput，并自动处理 tokenIn 拉取与授权。
    function swapExactOutput(
        ISwapRouter.ExactOutputParams calldata swapParams
    ) external payable returns (uint256 amountIn) {
        _pullToken(swapParams.tokenIn, msg.sender, swapParams.amountInMaximum);
        _approveIfNeeded(
            swapParams.tokenIn,
            address(swapRouter),
            swapParams.amountInMaximum
        );
        amountIn = swapRouter.exactOutput{value: msg.value}(swapParams);
        _refundToken(swapParams.tokenIn, msg.sender);
    }

    /// @notice 将 manager 当前持有的指定 token 返还给 recipient。
    function refundToken(address token, address recipient) external payable {
        _refundToken(token, recipient);
    }

    /// @notice 使用 EIP-2612 permit 为 MetaNodeManager 授权，无需单独发 approve。
    function selfPermit(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable {
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

    /// @notice allowance 不足时才执行 permit，便于前端只在必要时签名。
    function selfPermitIfNecessary(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable {
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

    function _resolvePoolIndex(
        address token0,
        address token1,
        address poolAddress
    ) private view returns (uint32) {
        IPoolManager.PoolInfo[] memory infos = poolManager.getAllPools();
        for (uint256 i = 0; i < infos.length; i++) {
            if (
                infos[i].pool == poolAddress &&
                infos[i].token0 == token0 &&
                infos[i].token1 == token1
            ) {
                return infos[i].index;
            }
        }
        revert("Pool index not found");
    }

    function _pullToken(address token, address from, uint256 amount) private {
        if (amount > 0) {
            TransferHelper.safeTransferFrom(token, from, address(this), amount);
        }
    }

    function _approveIfNeeded(
        address token,
        address spender,
        uint256 amount
    ) private {
        if (amount == 0) return;
        if (IERC20(token).allowance(address(this), spender) < amount) {
            IERC20(token).approve(spender, type(uint256).max);
        }
    }

    function _refundToken(address token, address recipient) private {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            TransferHelper.safeTransfer(token, recipient, balance);
        }
    }
}
