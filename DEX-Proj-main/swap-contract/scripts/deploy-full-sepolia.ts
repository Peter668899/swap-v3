import hre from "hardhat";

async function main() {
  const weth9 = process.env.WETH9_ADDRESS as `0x${string}` | undefined;
  if (!weth9) {
    throw new Error("请先设置 WETH9_ADDRESS");
  }

  const poolManager = await hre.viem.deployContract("PoolManager");
  const positionManager = await hre.viem.deployContract("PositionManager", [
    poolManager.address,
    weth9,
  ]);
  const swapRouter = await hre.viem.deployContract("SwapRouter", [
    poolManager.address,
    weth9,
  ]);
  const metaNodeManager = await hre.viem.deployContract("MetaNodeManager", [
    poolManager.address,
    positionManager.address,
    swapRouter.address,
  ]);

  console.log("PoolManager:", poolManager.address);
  console.log("PositionManager:", positionManager.address);
  console.log("SwapRouter:", swapRouter.address);
  console.log("MetaNodeManager:", metaNodeManager.address);
  console.log("WETH9:", weth9);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
