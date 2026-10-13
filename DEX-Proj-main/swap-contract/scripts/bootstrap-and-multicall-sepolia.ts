import hre from "hardhat";
import {
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
  parseGwei,
} from "viem";
import { encodeSqrtRatioX96, TickMath } from "@uniswap/v3-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const MIN_SQRT_RATIO = 4295128741n;
const MAX_SQRT_RATIO =
  1461446703485210103287273052203988822378723970341n - 1n;

function sortTokens(a: `0x${string}`, b: `0x${string}`) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function sqrtLimitForDirection(tokenIn: `0x${string}`, tokenOut: `0x${string}`) {
  return tokenIn.toLowerCase() < tokenOut.toLowerCase()
    ? MIN_SQRT_RATIO
    : MAX_SQRT_RATIO;
}

async function main() {
  const poolManagerAddress = process.env.POOL_MANAGER_ADDRESS as
    | `0x${string}`
    | undefined;
  const positionManagerAddress = process.env.POSITION_MANAGER_ADDRESS as
    | `0x${string}`
    | undefined;
  const swapRouterAddress = process.env.SWAP_ROUTER_ADDRESS as
    | `0x${string}`
    | undefined;
  const weth9Address = process.env.WETH9_ADDRESS as `0x${string}` | undefined;

  if (
    !poolManagerAddress ||
    !positionManagerAddress ||
    !swapRouterAddress ||
    !weth9Address
  ) {
    throw new Error(
      "请先在 .env 设置 POOL_MANAGER_ADDRESS / POSITION_MANAGER_ADDRESS / SWAP_ROUTER_ADDRESS / WETH9_ADDRESS"
    );
  }

  const poolManager = await hre.viem.getContractAt("PoolManager", poolManagerAddress);
  const positionManager = await hre.viem.getContractAt(
    "PositionManager",
    positionManagerAddress
  );
  const swapRouter = await hre.viem.getContractAt("SwapRouter", swapRouterAddress);
  const weth9 = await hre.viem.getContractAt("WETH9", weth9Address);
  const publicClient = await hre.viem.getPublicClient();
  const privateKey = (process.env.PRIVATE_KEY ||
    "0xc3403525339818ca6d633b409c2f8e31d24250b303f97311b3e2b3bc73516c1f") as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(
      process.env.SEPOLIA_RPC_URL ||
        "https://eth-sepolia.g.alchemy.com/v2/EykKv3BK7V4UWchOj2M9l"
    ),
  });

  const sendRawTx = async (tx: {
    to: `0x${string}`;
    data?: `0x${string}`;
    value?: bigint;
  }) => {
    const nonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });
    const maxPriorityFeePerGas = parseGwei("5");
    const maxFeePerGas = parseGwei("200"); // 防止 replacement underpriced

    return walletClient.sendTransaction({
      account,
      nonce,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      maxPriorityFeePerGas,
      maxFeePerGas,
    });
  };

  const token = await hre.viem.deployContract("TestToken");
  console.log("bootstrap token:", token.address);

  const [token0, token1] = sortTokens(token.address, weth9Address);
  const tickLower = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(1, 1));
  const tickUpper = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(40000, 1));
  const sqrtPriceX96 = BigInt(encodeSqrtRatioX96(10000, 1).toString());

  // 1) 创建并初始化 WETH-token 池
  const createTx = await poolManager.write.createAndInitializePoolIfNecessary([
    {
      token0,
      token1,
      fee: 3000,
      tickLower,
      tickUpper,
      sqrtPriceX96,
    },
  ]);
  console.log("create pool tx:", createTx);
  const createReceipt = await publicClient.waitForTransactionReceipt({
    hash: createTx,
  });
  if (createReceipt.status !== "success") {
    throw new Error("createAndInitializePoolIfNecessary 交易失败");
  }

  const allPools = await poolManager.read.getAllPools();
  const targetPools = allPools.filter(
    (p) =>
      p.token0.toLowerCase() === token0.toLowerCase() &&
      p.token1.toLowerCase() === token1.toLowerCase()
  );
  if (targetPools.length === 0) {
    throw new Error(
      `创建池后仍未找到目标池。allPools=${allPools.length}, token0=${token0}, token1=${token1}`
    );
  }
  const poolAddress = targetPools[0].pool;
  console.log("pool:", poolAddress);

  // 2) 注入最小流动性（PositionManager）
  const [hhWalletClient] = await hre.viem.getWalletClients();
  const [sender] = await hhWalletClient.getAddresses();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);

  const tokenForLiquidity = 10_000n * 10n ** 18n;
  const wethForLiquidity = parseEther("0.01");
  const mintTokenData = encodeFunctionData({
    abi: token.abi,
    functionName: "mint",
    args: [sender, tokenForLiquidity],
  });
  const mintTokenTx = await sendRawTx({
    to: token.address,
    data: mintTokenData as `0x${string}`,
  });
  const mintTokenReceipt = await publicClient.waitForTransactionReceipt({
    hash: mintTokenTx,
  });
  if (mintTokenReceipt.status !== "success") {
    throw new Error("TestToken.mint 交易失败");
  }
  const depositTx = await sendRawTx({
    to: weth9Address,
    value: wethForLiquidity,
    data: "0xd0e30db0" as `0x${string}`,
  });
  const depositReceipt = await publicClient.waitForTransactionReceipt({
    hash: depositTx,
  });
  if (depositReceipt.status !== "success") {
    throw new Error("WETH deposit 交易失败");
  }

  // allowance 不足才授权；授权时一次给最大值，后续交易可直接复用
  const ensureMaxAllowance = async (
    tokenContract: typeof token | typeof weth9,
    tokenAddress: `0x${string}`,
    spender: `0x${string}`,
    minAmount: bigint
  ) => {
    const allowance = (await tokenContract.read.allowance([
      sender,
      spender,
    ])) as bigint;
    if (allowance >= minAmount) {
      console.log(`skip approve, allowance already enough: ${tokenAddress}`);
      return;
    }
    const approveData = encodeFunctionData({
      abi: tokenContract.abi,
      functionName: "approve",
      args: [spender, (2n ** 256n - 1n) as bigint],
    });
    const approveTx = await sendRawTx({
      to: tokenAddress,
      data: approveData as `0x${string}`,
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({
      hash: approveTx,
    });
    if (approveReceipt.status !== "success") {
      throw new Error(`approve 交易失败: ${tokenAddress}`);
    }
    console.log(`approve max done: ${tokenAddress}`);
  };

  await ensureMaxAllowance(
    token,
    token.address,
    positionManagerAddress,
    tokenForLiquidity
  );
  await ensureMaxAllowance(weth9, weth9Address, positionManagerAddress, wethForLiquidity);

  const amount0Desired =
    token0.toLowerCase() === token.address.toLowerCase()
      ? tokenForLiquidity
      : wethForLiquidity;
  const amount1Desired =
    token1.toLowerCase() === token.address.toLowerCase()
      ? tokenForLiquidity
      : wethForLiquidity;

  const mintData = encodeFunctionData({
    abi: positionManager.abi,
    functionName: "mint",
    args: [
      {
        token0,
        token1,
        index: 0,
        amount0Desired,
        amount1Desired,
        recipient: sender,
        deadline,
      },
    ],
  });
  const mintTx = await sendRawTx({
    to: positionManagerAddress,
    data: mintData as `0x${string}`,
  });
  console.log("liquidity mint tx:", mintTx);
  const mintReceipt = await publicClient.waitForTransactionReceipt({
    hash: mintTx,
  });
  if (mintReceipt.status !== "success") {
    throw new Error("positionManager.mint 交易失败");
  }

  // 3) 执行 multicall: wrapETH + exactInput + unwrapWETH9
  const wrapValue = parseEther("0.002");
  const amountIn = parseEther("0.001");
  const swapDeadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);
  const sqrtPriceLimitX96 = sqrtLimitForDirection(weth9Address, token.address);

  const erc20Abi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
  const tokenBefore = (await publicClient.readContract({
    address: token.address,
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
        tokenIn: weth9Address,
        tokenOut: token.address,
        indexPath: [0],
        recipient: sender,
        deadline: swapDeadline,
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

  const multicallData = encodeFunctionData({
    abi: swapRouter.abi,
    functionName: "multicall",
    args: [[wrapCall, swapCall, unwrapCall]],
  });
  const txHash = await sendRawTx({
    to: swapRouterAddress,
    value: wrapValue,
    data: multicallData as `0x${string}`,
  });
  console.log("multicall tx:", txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const tokenAfter = (await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [sender],
  })) as bigint;

  console.log("multicall status:", receipt.status);
  console.log("token delta:", (tokenAfter - tokenBefore).toString());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
