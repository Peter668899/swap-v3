import hre from "hardhat";
import { encodeFunctionData, parseAbi, parseEther } from "viem";

const MIN_SQRT_RATIO = 4295128741n;
const MAX_SQRT_RATIO =
  1461446703485210103287273052203988822378723970341n - 1n;

function sqrtLimitForDirection(tokenIn: `0x${string}`, tokenOut: `0x${string}`) {
  return tokenIn.toLowerCase() < tokenOut.toLowerCase()
    ? MIN_SQRT_RATIO
    : MAX_SQRT_RATIO;
}

async function main() {
  const poolManagerAddress = process.env.POOL_MANAGER_ADDRESS as
    | `0x${string}`
    | undefined;
  const swapRouterAddress = process.env.SWAP_ROUTER_ADDRESS as
    | `0x${string}`
    | undefined;
  const weth9Address = process.env.WETH9_ADDRESS as `0x${string}` | undefined;

  if (!poolManagerAddress || !swapRouterAddress || !weth9Address) {
    throw new Error(
      "请在 .env 设置 POOL_MANAGER_ADDRESS / SWAP_ROUTER_ADDRESS / WETH9_ADDRESS"
    );
  }

  const poolManager = await hre.viem.getContractAt("PoolManager", poolManagerAddress);
  const swapRouter = await hre.viem.getContractAt("SwapRouter", swapRouterAddress);

  const allPools = await poolManager.read.getAllPools();
  const wethPools = allPools.filter(
    (p) =>
      p.token0.toLowerCase() === weth9Address.toLowerCase() ||
      p.token1.toLowerCase() === weth9Address.toLowerCase()
  );
  if (wethPools.length === 0) {
    throw new Error("当前 PoolManager 下没有 WETH 相关池子，无法执行 ETH 路径");
  }

  const first = wethPools[0];
  const tokenIn = weth9Address;
  const tokenOut =
    first.token0.toLowerCase() === weth9Address.toLowerCase()
      ? first.token1
      : first.token0;

  const indexPath = wethPools
    .filter(
      (p) =>
        ((p.token0.toLowerCase() === tokenIn.toLowerCase() &&
          p.token1.toLowerCase() === tokenOut.toLowerCase()) ||
          (p.token0.toLowerCase() === tokenOut.toLowerCase() &&
            p.token1.toLowerCase() === tokenIn.toLowerCase()))
    )
    .map((p) => p.index);

  if (indexPath.length === 0) {
    throw new Error("没有可用的 indexPath");
  }

  const [walletClient] = await hre.viem.getWalletClients();
  const [sender] = await walletClient.getAddresses();
  const publicClient = await hre.viem.getPublicClient();

  const wrapValue = parseEther("0.002");
  const amountIn = parseEther("0.001");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);
  const sqrtPriceLimitX96 = sqrtLimitForDirection(tokenIn, tokenOut);

  const erc20Abi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
  const tokenBefore = (await publicClient.readContract({
    address: tokenOut,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [sender],
  })) as bigint;

  const wrapCall = encodeFunctionData({
    abi: swapRouter.abi,
    functionName: "wrapETH",
    args: [],
  });
  const swapCall = encodeFunctionData({
    abi: swapRouter.abi,
    functionName: "exactInput",
    args: [
      {
        tokenIn,
        tokenOut,
        indexPath,
        recipient: sender,
        deadline,
        amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96,
      },
    ],
  });
  const unwrapCall = encodeFunctionData({
    abi: swapRouter.abi,
    functionName: "unwrapWETH9",
    args: [0n, sender],
  });

  const txHash = await swapRouter.write.multicall([[wrapCall, swapCall, unwrapCall]], {
    value: wrapValue,
  });
  console.log("multicall tx:", txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("status:", receipt.status);
  console.log("gasUsed:", receipt.gasUsed.toString());

  const tokenAfter = (await publicClient.readContract({
    address: tokenOut,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [sender],
  })) as bigint;
  console.log("tokenOut:", tokenOut);
  console.log("tokenOut delta:", (tokenAfter - tokenBefore).toString());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
