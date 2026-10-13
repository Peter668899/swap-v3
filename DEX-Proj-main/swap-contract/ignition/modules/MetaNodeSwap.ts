import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * MetaNodeSwap 部署模块
 *
 * 合约验证：部署时使用 --verify 参数可自动在 Etherscan 上验证源码，例如：
 *   npx hardhat run scripts/deploy-metanodeswap.ts --network sepolia
 * 或直接：
 *   npx hardhat ignition deploy ignition/modules/MetaNodeSwap.ts --network sepolia --verify
 *
 * 需设置 ETHERSCAN_API_KEY 环境变量。
 */
const MetaNodeSwapModule = buildModule("MetaNodeSwap", (m) => {
  const weth9 = m.getParameter(
    "weth9",
    "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"
  );
  const poolManager = m.contract("PoolManager");
  const swapRouter = m.contract("SwapRouter", [poolManager, weth9]);
  const positionManager = m.contract("PositionManager", [poolManager, weth9]);
  const metaNodeManager = m.contract("MetaNodeManager", [
    poolManager,
    positionManager,
    swapRouter,
  ]);

  return {
    poolManager,
    swapRouter,
    positionManager,
    metaNodeManager,
  };
});

export default MetaNodeSwapModule;
