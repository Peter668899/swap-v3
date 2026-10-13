import hre from "hardhat";

async function main() {
  const poolManager = process.env.POOL_MANAGER_ADDRESS as `0x${string}` | undefined;
  const weth9 = process.env.WETH9_ADDRESS as `0x${string}` | undefined;

  if (!poolManager) {
    throw new Error("请先设置 POOL_MANAGER_ADDRESS");
  }
  if (!weth9) {
    throw new Error("请先设置 WETH9_ADDRESS");
  }

  const swapRouter = await hre.viem.deployContract("SwapRouter", [
    poolManager,
    weth9,
  ]);

  console.log("SwapRouter:", swapRouter.address);
  console.log("poolManager:", poolManager);
  console.log("weth9:", weth9);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
