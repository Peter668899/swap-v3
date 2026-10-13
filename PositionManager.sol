// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./libraries/LiquidityAmounts.sol";
import "./libraries/TickMath.sol";
import "./libraries/FixedPoint128.sol";

import "./interfaces/IPositionManager.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IPoolManager.sol";
import "./interfaces/IWETH9.sol";
import "./base/Multicall.sol";
import "./libraries/TransferHelper.sol";

/// @title PositionManager
/// @notice 头寸管理合约：将「流动性头寸」铸成 ERC721 NFT，LP 通过 mint 注入流动性获得 NFT，通过 burn 撤出流动性、通过 collect 领取手续费与退出代币。
/// @dev 实际流动性在 Pool 中，本合约以 NFT 持有者为 owner 代理与 Pool 交互；实现 IMintCallback，在 Pool.mint 回调中从 payer 转入 token0/token1。
contract PositionManager is IPositionManager, ERC721, Multicall {
    /// @notice PoolManager 地址，用于根据 (token0, token1, index) 解析池子并执行 mint/burn/collect。
    IPoolManager public poolManager;
    /// @notice WETH9 合约地址，用于将 ETH 包装为 WETH 后参与加流动性。
    address public immutable WETH9;

    /// @dev The ID of the next token that will be minted. Skips 0
    uint176 private _nextId = 1;

    constructor(
        address _poolManger,
        address _weth9
    ) ERC721("MetaNodeSwapPosition", "MNSP") {
        poolManager = IPoolManager(_poolManger);
        WETH9 = _weth9;
    }

    receive() external payable {
        require(msg.sender == WETH9, "Not WETH9");
    }

    // 用一个 mapping 来存放所有 Position 的信息
    mapping(uint256 => PositionInfo) public positions;

    /// @notice 返回当前合约内所有已铸造头寸的元数据（id、owner、代币对、区间、流动性、待领手续费等），用于前端展示或批量查询。
    function getAllPositions()
        external
        view
        override
        returns (PositionInfo[] memory positionInfo)
    {
        positionInfo = new PositionInfo[](_nextId - 1);
        for (uint32 i = 0; i < _nextId - 1; i++) {
            positionInfo[i] = positions[i + 1];
        }
        return positionInfo;
    }

    function getSender() public view returns (address) {
        return msg.sender;
    }

    function _blockTimestamp() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    modifier checkDeadline(uint256 deadline) {
        require(_blockTimestamp() <= deadline, "Transaction too old");
        _;
    }

    /// @notice 在指定池子中按期望的 amount0/amount1 计算并注入流动性，铸造一枚 NFT 给 recipient，代表该头寸；调用前需对 token0、token1 授权足够额度。
    /// @param params 包含 token0、token1、index、数量期望、recipient、deadline 等
    /// @return positionId 新铸造的 NFT tokenId（即头寸 ID）
    /// @return liquidity 本次注入的流动性数量
    /// @return amount0 实际使用的 token0 数量
    /// @return amount1 实际使用的 token1 数量
    function mint(
        MintParams calldata params
    )
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (
            uint256 positionId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        )
    {
        MintParams memory mintParams = MintParams({
            token0: params.token0,
            token1: params.token1,
            index: params.index,
            amount0Desired: params.amount0Desired,
            amount1Desired: params.amount1Desired,
            recipient: params.recipient,
            deadline: params.deadline
        });
        (address payer, bool useNativeEth) = _resolveMintPayer(mintParams);
        return _mintPosition(mintParams, payer, useNativeEth);
    }

    function addLiquidity(
        MintParams calldata params
    )
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (
            uint256 positionId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        )
    {
        MintParams memory mintParams = MintParams({
            token0: params.token0,
            token1: params.token1,
            index: params.index,
            amount0Desired: params.amount0Desired,
            amount1Desired: params.amount1Desired,
            recipient: params.recipient,
            deadline: params.deadline
        });
        (address payer, bool useNativeEth) = _resolveMintPayer(mintParams);
        return _mintPosition(mintParams, payer, useNativeEth);
    }

    function createAndAddLiquidity(
        IPoolManager.CreateAndInitializeParams calldata poolParams,
        MintParams calldata mintParams
    )
        external
        payable
        override
        checkDeadline(mintParams.deadline)
        returns (
            uint256 positionId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        )
    {
        require(
            mintParams.token0 == poolParams.token0 &&
                mintParams.token1 == poolParams.token1,
            "Token mismatch"
        );
        address poolAddress = poolManager.createAndInitializePoolIfNecessary(
            poolParams
        );
        uint32 index = _resolvePoolIndex(
            poolParams.token0,
            poolParams.token1,
            poolAddress
        );
        MintParams memory mintCall = MintParams({
            token0: mintParams.token0,
            token1: mintParams.token1,
            index: index,
            amount0Desired: mintParams.amount0Desired,
            amount1Desired: mintParams.amount1Desired,
            recipient: mintParams.recipient,
            deadline: mintParams.deadline
        });
        (address payer, bool useNativeEth) = _resolveMintPayer(mintCall);
        return _mintPosition(mintCall, payer, useNativeEth);
    }

    modifier isAuthorizedForToken(uint256 tokenId) {
        address owner = ERC721.ownerOf(tokenId);
        require(_isAuthorized(owner, msg.sender, tokenId), "Not approved");
        _;
    }

    /// @notice 撤销指定头寸的全部流动性：从池子 burn 对应 liquidity，应得 token0/token1 与未领手续费一并记入该头寸的 tokensOwed，需后续调用 collect 取回；若流动性为 0 且已领完，collect 时会销毁 NFT。
    /// @param positionId NFT tokenId（头寸 ID）
    /// @return amount0 本次撤出对应的 token0 数量（已累加到 tokensOwed，未实际转出）
    /// @return amount1 本次撤出对应的 token1 数量（已累加到 tokensOwed，未实际转出）
    function burn(
        uint256 positionId
    )
        external
        override
        isAuthorizedForToken(positionId)
        returns (uint256 amount0, uint256 amount1)
    {
        return _burnPosition(positionId);
    }

    /// @dev 撤出指定 NFT 头寸的全部流动性并结算手续费。
    ///      执行流程：
    ///      1. 调用 Pool.burn 减少 Pool 层面的聚合流动性 → 返回退还的本金 (amount0, amount1)
    ///         Pool.burn 内部调用 _modifyPosition，会先结算聚合层手续费并更新 Pool 的 feeGrowthLast
    ///      2. 从 Pool 读取更新后的 feeGrowthLast（= 当前 feeGrowthGlobal）
    ///      3. 计算该 NFT 的个体手续费 = (feeGrowthGlobal − NFT 快照值) × NFT 流动性 / Q128
    ///      4. 本金 + 手续费 合并记入 tokensOwed，等待 collect 提取
    function _burnPosition(
        uint256 positionId
    ) private returns (uint256 amount0, uint256 amount1) {
        PositionInfo storage position = positions[positionId];
        uint128 _liquidity = position.liquidity;
        address _pool = poolManager.getPool(
            position.token0,
            position.token1,
            position.index
        );
        IPool pool = IPool(_pool);

        // Pool.burn → Pool._modifyPosition：结算聚合手续费、减少聚合流动性、累加 burn 本金到 Pool.tokensOwed
        // 返回的 amount0/amount1 仅为 burn 退还的本金，不含手续费
        (amount0, amount1) = pool.burn(_liquidity);

        // Pool._modifyPosition 已将 feeGrowthLast 推进到 feeGrowthGlobal，读取作为当前快照
        (
            ,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            ,

        ) = pool.getPosition(address(this));

        // tokensOwed = burn 退还本金 + 该 NFT 自创建/上次更新以来累积的手续费
        // 手续费公式：(当前 feeGrowthGlobal − NFT 上次快照值) × NFT 流动性 / Q128
        // 注意：此时 position.liquidity 尚未清零（第 249 行才清零），所以这里读到的是正确的原始值
        position.tokensOwed0 +=
            uint128(amount0) +
            uint128(
                FullMath.mulDiv(
                    feeGrowthInside0LastX128 -
                        position.feeGrowthInside0LastX128,
                    position.liquidity,
                    FixedPoint128.Q128
                )
            );

        position.tokensOwed1 +=
            uint128(amount1) +
            uint128(
                FullMath.mulDiv(
                    feeGrowthInside1LastX128 -
                        position.feeGrowthInside1LastX128,
                    position.liquidity,
                    FixedPoint128.Q128
                )
            );

        // 推进快照并清零流动性，后续通过 collect 提取 tokensOwed
        position.feeGrowthInside0LastX128 = feeGrowthInside0LastX128;
        position.feeGrowthInside1LastX128 = feeGrowthInside1LastX128;
        position.liquidity = 0;
    }

    /// @notice 领取指定头寸的 tokensOwed0/tokensOwed1（手续费 + burn 应退代币）到 recipient；若该头寸流动性已为 0 且领完则销毁对应 NFT。
    /// @param positionId 头寸 NFT 的 tokenId
    /// @param recipient 接收代币的地址
    /// @return amount0 实际转出的 token0 数量
    /// @return amount1 实际转出的 token1 数量
    function collect(
        uint256 positionId,
        address recipient
    )
        external
        override
        isAuthorizedForToken(positionId)
        returns (uint256 amount0, uint256 amount1)
    {
        return _collectPosition(positionId, recipient);
    }

    /// @dev 从 Pool 的 tokensOwed 中提取该 NFT 记录的待领代币（本金 + 手续费），转给 recipient。
    ///      Pool.collect 返回实际转出量（取 min(requested, pool_tokensOwed)）。
    ///      若该头寸流动性已为 0（已 burn），提取后销毁 NFT。
    function _collectPosition(
        uint256 positionId,
        address recipient
    ) private returns (uint256 amount0, uint256 amount1) {
        PositionInfo storage position = positions[positionId];
        address _pool = poolManager.getPool(
            position.token0,
            position.token1,
            position.index
        );
        IPool pool = IPool(_pool);
        // Pool.collect 从 Pool 聚合 tokensOwed 中扣减并转账给 recipient
        (amount0, amount1) = pool.collect(
            recipient,
            position.tokensOwed0,
            position.tokensOwed1
        );

        position.tokensOwed0 = 0;
        position.tokensOwed1 = 0;

        // 流动性已为 0 且代币已领取 → 该 NFT 无存在意义，销毁
        if (position.liquidity == 0) {
            _burn(positionId);
        }
    }

    function removeLiquidity(
        uint256 positionId,
        address recipient,
        bool collectAfterBurn
    ) external override returns (uint256 amount0, uint256 amount1) {
        require(_isAuthorized(ERC721.ownerOf(positionId), msg.sender, positionId), "Not approved");
        (amount0, amount1) = _burnPosition(positionId);
        if (collectAfterBurn) {
            _collectPosition(positionId, recipient);
        }
    }

    function collectLiquidity(
        uint256 positionId,
        address recipient
    ) external override returns (uint256 amount0, uint256 amount1) {
        require(_isAuthorized(ERC721.ownerOf(positionId), msg.sender, positionId), "Not approved");
        return _collectPosition(positionId, recipient);
    }

    /// @notice Pool.mint 的回调：从 data 解码出 token0、token1、index、payer，校验调用方为合法池子后，从 payer 向 Pool 转入 amount0/amount1；用户须已对 PositionManager 授权。
    function mintCallback(
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external override {
        // 检查 callback 的合约地址是否是 Pool
        (
            address token0,
            address token1,
            uint32 index,
            address payer,
            bool useNativeEth
        ) = abi.decode(data, (address, address, uint32, address, bool));
        address _pool = poolManager.getPool(token0, token1, index);
        require(_pool == msg.sender, "Invalid callback caller");

        // 在这里给 Pool 打钱，需要用户先 approve 足够的金额，这里才会成功
        if (amount0 > 0) {
            _payMintToken(token0, amount0, payer, useNativeEth);
        }
        if (amount1 > 0) {
            _payMintToken(token1, amount1, payer, useNativeEth);
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

    /// @dev 执行铸造新头寸的核心逻辑：
    ///      1. 根据期望数量计算 liquidity
    ///      2. 调用 Pool.mint 注入流动性（Pool 通过 mintCallback 回调拉取代币）
    ///      3. 铸造 ERC721 NFT 给 recipient
    ///      4. 记录 feeGrowthLast 快照，作为未来手续费结算的基准
    function _mintPosition(
        MintParams memory params,
        address payer,
        bool useNativeEth
    )
        private
        returns (
            uint256 positionId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        )
    {
        address _pool = poolManager.getPool(
            params.token0,
            params.token1,
            params.index
        );
        IPool pool = IPool(_pool);

        // 根据期望的 amount0/amount1 和当前价格、区间，反算出能注入的 liquidity 值
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            pool.sqrtPriceX96(),
            TickMath.getSqrtPriceAtTick(pool.tickLower()),
            TickMath.getSqrtPriceAtTick(pool.tickUpper()),
            params.amount0Desired,
            params.amount1Desired
        );

        // data 传给 Pool，Pool 在 mintCallback 中解码以从 payer 拉取代币
        bytes memory data = abi.encode(
            params.token0,
            params.token1,
            params.index,
            payer,
            useNativeEth
        );

        // Pool.mint 内部调用 _modifyPosition（结算已有头寸的手续费、增加 liquidity），
        // 然后回调 mintCallback 从 payer 转入代币
        (amount0, amount1) = pool.mint(address(this), liquidity, data);

        _mint(params.recipient, (positionId = _nextId++));

        // 读取 Pool 聚合 position 当前的 feeGrowthLast（刚被 _modifyPosition 更新为 feeGrowthGlobal）
        // 作为新 NFT 的手续费基准——此 NFT 只能领取从此刻之后产生的手续费
        (
            ,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            ,

        ) = pool.getPosition(address(this));

        positions[positionId] = PositionInfo({
            id: positionId,
            owner: params.recipient,
            token0: params.token0,
            token1: params.token1,
            index: params.index,
            fee: pool.fee(),
            liquidity: liquidity,
            tickLower: pool.tickLower(),
            tickUpper: pool.tickUpper(),
            tokensOwed0: 0,
            tokensOwed1: 0,
            feeGrowthInside0LastX128: feeGrowthInside0LastX128,
            feeGrowthInside1LastX128: feeGrowthInside1LastX128
        });

        // 若用户通过 ETH 支付 WETH 侧，退还未使用的 ETH 余额
        if (useNativeEth && address(this).balance > 0) {
            TransferHelper.safeTransferETH(payer, address(this).balance);
        }
    }

    function _resolveMintPayer(
        MintParams memory params
    ) private view returns (address payer, bool useNativeEth) {
        if (msg.value == 0) {
            return (msg.sender, false);
        }

        require(
            params.token0 == WETH9 || params.token1 == WETH9,
            "WETH9 required"
        );

        // ETH 只作为 WETH 侧的最大支付额度，避免前端必须先 wrap 再 approve。
        if (params.token0 == WETH9) {
            require(msg.value <= params.amount0Desired, "ETH exceeds amount0");
        } else {
            require(msg.value <= params.amount1Desired, "ETH exceeds amount1");
        }

        return (msg.sender, true);
    }

    function _payMintToken(
        address token,
        uint256 amount,
        address payer,
        bool useNativeEth
    ) private {
        if (useNativeEth && token == WETH9 && address(this).balance >= amount) {
            IWETH9(WETH9).deposit{value: amount}();
            TransferHelper.safeTransfer(WETH9, msg.sender, amount);
            return;
        }
        TransferHelper.safeTransferFrom(token, payer, msg.sender, amount);
    }
}
