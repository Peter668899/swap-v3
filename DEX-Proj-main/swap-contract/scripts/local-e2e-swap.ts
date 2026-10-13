/**
 * MetaNodeSwap 本地端到端 Swap 演示
 *
 * 在本地 Hardhat 链上完成:
 *   部署代币/合约 -> 创建两个费率池 -> 注入流动性 -> 报价(quote)
 *   -> exactInput / exactOutput 真实 swap -> 校验余额变化与池子价格变动
 *
 * 用法:
 *   # 方式 A: 内置临时链(最简)
 *   npx hardhat run scripts/local-e2e-swap.ts
 *
 *   # 方式 B: 连本地常驻节点(更接近"本地系统")
 *   #   终端1: npx hardhat node
 *   #   终端2: npx hardhat run scripts/local-e2e-swap.ts --network localhost
 */
import hre from "hardhat";
import { encodeSqrtRatioX96, TickMath } from "@uniswap/v3-sdk";

const ONE = 10n ** 18n;

function fmt(v: bigint, decimals = 18): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

function sqrtPriceLimitFor(tokenIn: string, tokenOut: string) {
  const MIN_SQRT_RATIO = 4295128741n;
  const MAX_SQRT_RATIO =
    1461446703485210103287273052203988822378723970341n - 1n;
  return tokenIn.toLowerCase() < tokenOut.toLowerCase()
    ? MIN_SQRT_RATIO
    : MAX_SQRT_RATIO;
}

async function main() {
  const network = hre.network.name;
  console.log("============================================================");
  console.log(" MetaNodeSwap 本地端到端 Swap 演示  (network:", network + ")");
  console.log("============================================================");

  // 1. 部署测试代币与 WETH9
  const tokenA = await hre.viem.deployContract("TestToken"); // 符号 TK
  const tokenB = await hre.viem.deployContract("TestToken");
  const weth9 = await hre.viem.deployContract("WETH9");

  // token0/token1 按地址排序(合约要求 token0 < token1)
  const [token0, token1] =
    tokenA.address < tokenB.address ? [tokenA, tokenB] : [tokenB, tokenA];

  // 2. 部署核心合约
  const poolManager = await hre.viem.deployContract("PoolManager");
  const positionManager = await hre.viem.deployContract("PositionManager", [
    poolManager.address,
    weth9.address,
  ]);
  const swapRouter = await hre.viem.deployContract("SwapRouter", [
    poolManager.address,
    weth9.address,
  ]);

  console.log("部署地址:");
  console.log("  token0   :", token0.address);
  console.log("  token1   :", token1.address);
  console.log("  WETH9    :", weth9.address);
  console.log("  PoolManager     :", poolManager.address);
  console.log("  PositionManager :", positionManager.address);
  console.log("  SwapRouter      :", swapRouter.address);

  // 3. 建池: 初始价格 1 token0 = 10000 token1, 价格范围 [1, 40000]
  const tickLower = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(1, 1));
  const tickUpper = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(40000, 1));
  const sqrtPriceX96 = BigInt(encodeSqrtRatioX96(10000, 1).toString());

  for (const fee of [3000, 10000]) {
    await poolManager.write.createAndInitializePoolIfNecessary([
      {
        token0: token0.address,
        token1: token1.address,
        tickLower,
        tickUpper,
        fee,
        sqrtPriceX96,
      },
    ]);
    console.log(`  已创建池子 fee=${fee} (index=${
      fee === 3000 ? 0 : 1
    }) @ 价格 1:10000`);
  }

  // 4. 注入流动性: 两个池子各 L = 50000
  const L = 50000n * ONE;
  const testLP = await hre.viem.deployContract("TestLP");
  const mintAmount = 1000000000000n * ONE; // 足够覆盖任一方向的资金需求
  await token0.write.mint([testLP.address, mintAmount]);
  await token1.write.mint([testLP.address, mintAmount]);
  // TestLP 走 transfer 转账给 Pool, 无需授权; 下面的 approve 仅是保险
  const pool0 = (await poolManager.read.getPool([
    token0.address,
    token1.address,
    0,
  ])) as `0x${string}`;
  const pool1 = (await poolManager.read.getPool([
    token0.address,
    token1.address,
    1,
  ])) as `0x${string}`;
  for (const p of [pool0, pool1]) {
    await token0.write.approve([p, mintAmount]);
    await token1.write.approve([p, mintAmount]);
    await testLP.write.mint([testLP.address, L, p, token0.address, token1.address]);
  }
  console.log("  已向 pool0/pool1 各注入流动性 L = 50000");

  const [walletClient] = await hre.viem.getWalletClients();
  const [sender] = await walletClient.getAddresses();
  const publicClient = await hre.viem.getPublicClient();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);

  // 5. 给交易者充值并授权
  await token0.write.mint([sender, 1000000n * ONE]);
  await token0.write.approve([swapRouter.address, 1000000n * ONE]);
  await token1.write.mint([sender, 1000000n * ONE]);
  await token1.write.approve([swapRouter.address, 1000000n * ONE]);

  const bal0 = async () => (await token0.read.balanceOf([sender])) as bigint;
  const bal1 = async () => (await token1.read.balanceOf([sender])) as bigint;

  // 6. 报价 + exactInput: 10 token0 -> token1 (路径 [0,1], 实际由 pool0 成交)
  const amountIn = 10n * ONE;
  const quoteBefore = (await swapRouter.simulate.quoteExactInput([
    {
      tokenIn: token0.address,
      tokenOut: token1.address,
      amountIn,
      indexPath: [0, 1],
      sqrtPriceLimitX96: sqrtPriceLimitFor(token0.address, token1.address),
    },
  ])).result as bigint;

  console.log("\n[swap 1] exactInput  10 token0 -> token1");
  console.log("  报价(预期输出)      :", fmt(quoteBefore), "token1");

  const b0 = await bal0();
  const b1 = await bal1();
  const txHash = await swapRouter.write.exactInput([
    {
      tokenIn: token0.address,
      tokenOut: token1.address,
      amountIn,
      amountOutMinimum: (quoteBefore * 98n) / 100n, // 2% 滑点保护
      indexPath: [0, 1],
      sqrtPriceLimitX96: sqrtPriceLimitFor(token0.address, token1.address),
      recipient: sender,
      deadline,
    },
  ]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const a0 = await bal0();
  const a1 = await bal1();
  console.log("  tx            :", txHash);
  console.log("  status        :", receipt.status, " gas:", receipt.gasUsed.toString());
  console.log("  token0 变化   :", fmt(b0), "->", fmt(a0), "( 消耗", fmt(b0 - a0), ")");
  console.log("  token1 变化   :", fmt(b1), "->", fmt(a1), "( 收到", fmt(a1 - b1), ")");
  const pct = Number(((a1 - b1) * 10000n) / quoteBefore) / 100;
  console.log("  实际输出/报价 :", pct.toFixed(2) + "%");

  // 7. 反向 exactInput: 用收到的 token1 换回一部分 token0 (路径 [0,1])
  const amountBack = (a1 - b1) / 10n; // 用 1/10 的输出换回去
  const quoteBack = (await swapRouter.simulate.quoteExactInput([
    {
      tokenIn: token1.address,
      tokenOut: token0.address,
      amountIn: amountBack,
      indexPath: [0, 1],
      sqrtPriceLimitX96: sqrtPriceLimitFor(token1.address, token0.address),
    },
  ])).result as bigint;

  console.log("\n[swap 2] exactInput  反向 token1 -> token0 (数量", fmt(amountBack) + ")");
  console.log("  报价(预期输出)      :", fmt(quoteBack), "token0");

  const c0 = await bal0();
  const c1 = await bal1();
  await swapRouter.write.exactInput([
    {
      tokenIn: token1.address,
      tokenOut: token0.address,
      amountIn: amountBack,
      amountOutMinimum: (quoteBack * 98n) / 100n,
      indexPath: [0, 1],
      sqrtPriceLimitX96: sqrtPriceLimitFor(token1.address, token0.address),
      recipient: sender,
      deadline,
    },
  ]);
  const d0 = await bal0();
  const d1 = await bal1();
  console.log("  token1 变化   :", fmt(c1), "->", fmt(d1), "( 消耗", fmt(c1 - d1), ")");
  console.log("  token0 变化   :", fmt(c0), "->", fmt(d0), "( 收到", fmt(d0 - c0), ")");

  // 8. exactOutput: 精确拿到 5000 token1, 看要花多少 token0
  const amountOut = 5000n * ONE;
  const quoteIn = (await swapRouter.simulate.quoteExactOutput([
    {
      tokenIn: token0.address,
      tokenOut: token1.address,
      amountOut,
      indexPath: [0, 1],
      sqrtPriceLimitX96: sqrtPriceLimitFor(token0.address, token1.address),
    },
  ])).result as bigint;

  console.log("\n[swap 3] exactOutput 精确输出 5000 token1");
  console.log("  报价(需投入)        :", fmt(quoteIn), "token0");

  const e0 = await bal0();
  const e1 = await bal1();
  await swapRouter.write.exactOutput([
    {
      tokenIn: token0.address,
      tokenOut: token1.address,
      amountOut,
      amountInMaximum: (quoteIn * 102n) / 100n,
      indexPath: [0, 1],
      sqrtPriceLimitX96: sqrtPriceLimitFor(token0.address, token1.address),
      recipient: sender,
      deadline,
    },
  ]);
  const f0 = await bal0();
  const f1 = await bal1();
  console.log("  token0 消耗   :", fmt(e0 - f0), "( 预算", fmt((quoteIn * 102n) / 100n), ")");
  console.log("  token1 实收   :", fmt(f1 - e1), "(应等于", fmt(amountOut), ")");

  // 9. 池子状态: 展示 swap 后价格移动 & 手续费
  const poolsAfter = (await poolManager.read.getAllPools()) as any[];
  console.log("\n[池子状态] (index / fee / liquidity / tick / sqrtPriceX96)");
  for (const p of poolsAfter) {
    console.log(
      `  index=${p.index} fee=${p.fee} liquidity=${fmt(p.liquidity)} tick=${p.tick} sqrtPriceX96=${p.sqrtPriceX96}`
    );
  }

  const ok = a1 - b1 >= quoteBefore - (quoteBefore * 2n) / 100n;
  console.log("\n============================================================");
  console.log(ok ? " ✅ 本地 swap 系统跑通: 建池/加流动性/报价/成交全部成功"
                : " ❌ 输出低于滑点保护阈值, 请检查");
  console.log("============================================================");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
