// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "./IPoolManager.sol";

    /// @notice mint 返回结果聚合（用于降低 _mintPosition 栈深度）。
    struct MintResult {
        uint256 positionId;
        uint128 liquidity;
        uint256 amount0;
        uint256 amount1;
    }

/// @title IPositionManager
/// @notice 头寸管理器接口：定义流动性头寸的 NFT 铸造、销毁、领取及查询标准。
interface IPositionManager is IERC721 {
    /// @notice 头寸信息结构体，记录每个 NFT 头寸的完整状态。
    struct PositionInfo {
        uint256 id;                             // NFT tokenId
        address owner;                          // NFT 持有者
        address token0;                         // 代币 0
        address token1;                         // 代币 1
        uint32 index;                           // 池子索引
        uint24 fee;                             // 手续费率
        uint128 liquidity;                      // 当前流动性
        int24 tickLower;                        // 价格区间下界
        int24 tickUpper;                        // 价格区间上界
        uint128 tokensOwed0;                    // 待领 token0（本金+手续费）
        uint128 tokensOwed1;                    // 待领 token1（本金+手续费）
        uint256 feeGrowthInside0LastX128;       // token0 手续费快照（用于计算新产生的手续费）
        uint256 feeGrowthInside1LastX128;       // token1 手续费快照
    }

    /// @notice 返回所有已铸造头寸的信息列表。
    /// @return positionInfo 头寸信息数组
    function getAllPositions()
        external
        view
        returns (PositionInfo[] memory positionInfo);

    /// @notice 铸造头寸的参数结构体。
    struct MintParams {
        address token0;         // 代币 0
        address token1;         // 代币 1
        uint32 index;           // 池子索引
        uint256 amount0Desired; // 期望投入的 token0 数量
        uint256 amount1Desired; // 期望投入的 token1 数量
        address recipient;      // NFT 接收地址
        uint256 deadline;       // 交易截止时间
    }

    /// @notice 铸造新头寸（注入流动性并铸造 NFT）。
    function mint(
        MintParams calldata params
    )
        external
        payable
        returns (
            uint256 positionId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        );

    /// @notice 向已有池子添加流动性（铸造新 NFT）。
    function addLiquidity(
        MintParams calldata params
    )
        external
        payable
        returns (
            uint256 positionId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        );

    /// @notice 创建池子并立即添加流动性（一步完成）。
    function createAndAddLiquidity(
        IPoolManager.CreateAndInitializeParams calldata poolParams,
        MintParams calldata mintParams
    )
        external
        payable
        returns (
            uint256 positionId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        );

    /// @notice 销毁头寸（撤出全部流动性）。
    /// @param positionId 头寸 NFT 的 tokenId
    /// @return amount0 应退 token0 数量
    /// @return amount1 应退 token1 数量
    function burn(
        uint256 positionId
    ) external returns (uint256 amount0, uint256 amount1);

    /// @notice 领取头寸的待领代币（手续费 + burn 退还本金）。
    /// @param positionId 头寸 NFT 的 tokenId
    /// @param recipient 接收代币的地址
    /// @return amount0 实际转出的 token0 数量
    /// @return amount1 实际转出的 token1 数量
    function collect(
        uint256 positionId,
        address recipient
    ) external returns (uint256 amount0, uint256 amount1);

    /// @notice 移除流动性，可选立即 collect。
    function removeLiquidity(
        uint256 positionId,
        address recipient,
        bool collectAfterBurn
    ) external returns (uint256 amount0, uint256 amount1);

    /// @notice 仅 collect 头寸的待领代币（不执行 burn）。
    function collectLiquidity(
        uint256 positionId,
        address recipient
    ) external returns (uint256 amount0, uint256 amount1);

    /// @notice Pool.mint 的回调函数。
    function mintCallback(
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;
}
