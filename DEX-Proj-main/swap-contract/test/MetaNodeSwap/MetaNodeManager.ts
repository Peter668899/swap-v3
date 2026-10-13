import { expect } from "chai";
import hre, { viem } from "hardhat";
import { encodeFunctionData, parseSignature } from "viem";
import { encodeSqrtRatioX96, TickMath } from "@uniswap/v3-sdk";

describe("MetaNodeManager", function () {
  it("creates pool, adds liquidity and swaps in one call", async function () {
    const tokenA = await hre.viem.deployContract("TestToken");
    const tokenB = await hre.viem.deployContract("TestToken");
    const weth9 = await hre.viem.deployContract("WETH9");

    const token0 = tokenA.address < tokenB.address ? tokenA : tokenB;
    const token1 = tokenA.address < tokenB.address ? tokenB : tokenA;

    const poolManager = await viem.deployContract("PoolManager");
    const positionManager = await viem.deployContract("PositionManager", [
      poolManager.address,
      weth9.address,
    ]);
    const swapRouter = await viem.deployContract("SwapRouter", [
      poolManager.address,
      weth9.address,
    ]);
    const metaNodeManager = await viem.deployContract("MetaNodeManager", [
      poolManager.address,
      positionManager.address,
      swapRouter.address,
    ]);

    const [walletClient] = await hre.viem.getWalletClients();
    const [sender] = await walletClient.getAddresses();

    const seedAmount = 1_000_000n * 10n ** 18n;
    await token0.write.mint([sender, seedAmount]);
    await token1.write.mint([sender, seedAmount]);

    await token0.write.approve([metaNodeManager.address, seedAmount]);
    await token1.write.approve([metaNodeManager.address, seedAmount]);

    const tickLower = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(1, 1));
    const tickUpper = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(40000, 1));
    const sqrtPriceX96 = BigInt(encodeSqrtRatioX96(10000, 1).toString());
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1000);

    const minSqrtRatioX96 = 4295128741n;
    const maxSqrtRatioX96 =
      1461446703485210103287273052203988822378723970341n - 1n;
    const sqrtPriceLimitX96 =
      token0.address.toLowerCase() < token1.address.toLowerCase()
        ? minSqrtRatioX96
        : maxSqrtRatioX96;

    const params = {
      poolParams: {
        token0: token0.address,
        token1: token1.address,
        fee: 3000,
        tickLower,
        tickUpper,
        sqrtPriceX96,
      },
      mintParams: {
        token0: token0.address,
        token1: token1.address,
        index: 0,
        amount0Desired: 1000n * 10n ** 18n,
        amount1Desired: 1000n * 10n ** 18n,
        recipient: sender,
        deadline,
      },
      executeSwap: true,
      swapParams: {
        tokenIn: token0.address,
        tokenOut: token1.address,
        indexPath: [0],
        recipient: sender,
        deadline,
        amountIn: 1n * 10n ** 18n,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96,
      },
    };

    const simulated = await metaNodeManager.simulate.execute([params]);
    expect((simulated.result[5] as bigint) > 0n).to.equal(true);

    await metaNodeManager.write.execute([params]);

    const managerToken0 = await token0.read.balanceOf([metaNodeManager.address]);
    const managerToken1 = await token1.read.balanceOf([metaNodeManager.address]);
    expect(managerToken0).to.equal(0n);
    expect(managerToken1).to.equal(0n);

    const positionNftBalance = await positionManager.read.balanceOf([sender]);
    expect(positionNftBalance).to.equal(1n);
  });

  it("supports free composition via manager multicall", async function () {
    const tokenA = await hre.viem.deployContract("TestToken");
    const tokenB = await hre.viem.deployContract("TestToken");
    const weth9 = await hre.viem.deployContract("WETH9");

    const token0 = tokenA.address < tokenB.address ? tokenA : tokenB;
    const token1 = tokenA.address < tokenB.address ? tokenB : tokenA;

    const poolManager = await viem.deployContract("PoolManager");
    const positionManager = await viem.deployContract("PositionManager", [
      poolManager.address,
      weth9.address,
    ]);
    const swapRouter = await viem.deployContract("SwapRouter", [
      poolManager.address,
      weth9.address,
    ]);
    const metaNodeManager = await viem.deployContract("MetaNodeManager", [
      poolManager.address,
      positionManager.address,
      swapRouter.address,
    ]);

    const [walletClient] = await hre.viem.getWalletClients();
    const [sender] = await walletClient.getAddresses();

    const seedAmount = 1_000_000n * 10n ** 18n;
    await token0.write.mint([sender, seedAmount]);
    await token1.write.mint([sender, seedAmount]);
    await token0.write.approve([metaNodeManager.address, seedAmount]);
    await token1.write.approve([metaNodeManager.address, seedAmount]);

    const tickLower = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(1, 1));
    const tickUpper = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(40000, 1));
    const sqrtPriceX96 = BigInt(encodeSqrtRatioX96(10000, 1).toString());
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1000);
    const minSqrtRatioX96 = 4295128741n;
    const maxSqrtRatioX96 =
      1461446703485210103287273052203988822378723970341n - 1n;
    const sqrtPriceLimitX96 =
      token0.address.toLowerCase() < token1.address.toLowerCase()
        ? minSqrtRatioX96
        : maxSqrtRatioX96;

    const createPoolCall = encodeFunctionData({
      abi: metaNodeManager.abi,
      functionName: "createPool",
      args: [
        {
          token0: token0.address,
          token1: token1.address,
          fee: 3000,
          tickLower,
          tickUpper,
          sqrtPriceX96,
        },
      ],
    });

    const addLiquidityCall = encodeFunctionData({
      abi: metaNodeManager.abi,
      functionName: "addLiquidity",
      args: [
        {
          token0: token0.address,
          token1: token1.address,
          index: 0,
          amount0Desired: 1000n * 10n ** 18n,
          amount1Desired: 1000n * 10n ** 18n,
          recipient: sender,
          deadline,
        },
      ],
    });

    const swapCall = encodeFunctionData({
      abi: metaNodeManager.abi,
      functionName: "swapExactInput",
      args: [
        {
          tokenIn: token0.address,
          tokenOut: token1.address,
          indexPath: [0],
          recipient: sender,
          deadline,
          amountIn: 1n * 10n ** 18n,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96,
        },
      ],
    });

    await metaNodeManager.write.multicall([
      [createPoolCall, addLiquidityCall, swapCall],
    ]);

    const nftBalance = await positionManager.read.balanceOf([sender]);
    expect(nftBalance).to.equal(1n);
  });

  it("creates ETH/USDT pool and adds liquidity", async function () {
    const usdt = await hre.viem.deployContract("TestToken");
    const weth9 = await hre.viem.deployContract("WETH9");

    const token0 = usdt.address < weth9.address ? usdt : weth9;
    const token1 = usdt.address < weth9.address ? weth9 : usdt;

    const poolManager = await viem.deployContract("PoolManager");
    const positionManager = await viem.deployContract("PositionManager", [
      poolManager.address,
      weth9.address,
    ]);
    const swapRouter = await viem.deployContract("SwapRouter", [
      poolManager.address,
      weth9.address,
    ]);
    const metaNodeManager = await viem.deployContract("MetaNodeManager", [
      poolManager.address,
      positionManager.address,
      swapRouter.address,
    ]);

    const [walletClient] = await hre.viem.getWalletClients();
    const [sender] = await walletClient.getAddresses();

    const ethAmount = 1n * 10n ** 18n;
    const usdtAmount = 3000n * 10n ** 18n;

    await weth9.write.deposit({ value: ethAmount });
    await usdt.write.mint([sender, usdtAmount]);
    await weth9.write.approve([metaNodeManager.address, ethAmount]);
    await usdt.write.approve([metaNodeManager.address, usdtAmount]);

    const tickLower = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(1, 1));
    const tickUpper = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(40000, 1));
    const sqrtPriceX96 = BigInt(encodeSqrtRatioX96(3000, 1).toString());
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1000);

    const amount0Desired =
      token0.address.toLowerCase() === weth9.address.toLowerCase()
        ? ethAmount
        : usdtAmount;
    const amount1Desired =
      token1.address.toLowerCase() === weth9.address.toLowerCase()
        ? ethAmount
        : usdtAmount;

    const createPoolCall = encodeFunctionData({
      abi: metaNodeManager.abi,
      functionName: "createPool",
      args: [
        {
          token0: token0.address,
          token1: token1.address,
          fee: 3000,
          tickLower,
          tickUpper,
          sqrtPriceX96,
        },
      ],
    });

    const addLiquidityCall = encodeFunctionData({
      abi: metaNodeManager.abi,
      functionName: "addLiquidity",
      args: [
        {
          token0: token0.address,
          token1: token1.address,
          index: 0,
          amount0Desired,
          amount1Desired,
          recipient: sender,
          deadline,
        },
      ],
    });

    await metaNodeManager.write.multicall([[createPoolCall, addLiquidityCall]]);

    const allPools = await poolManager.read.getAllPools();
    expect(allPools.length).to.equal(1);
    const poolAddress = allPools[0].pool;

    const wethInPool = await weth9.read.balanceOf([poolAddress]);
    const usdtInPool = await usdt.read.balanceOf([poolAddress]);
    expect(wethInPool > 0n).to.equal(true);
    expect(usdtInPool > 0n).to.equal(true);

    const nftBalance = await positionManager.read.balanceOf([sender]);
    expect(nftBalance).to.equal(1n);
  });

  it("supports selfPermit and selfPermitIfNecessary", async function () {
    const permitToken = await hre.viem.deployContract("TestTokenPermit");
    const weth9 = await hre.viem.deployContract("WETH9");
    const poolManager = await viem.deployContract("PoolManager");
    const positionManager = await viem.deployContract("PositionManager", [
      poolManager.address,
      weth9.address,
    ]);
    const swapRouter = await viem.deployContract("SwapRouter", [
      poolManager.address,
      weth9.address,
    ]);
    const metaNodeManager = await viem.deployContract("MetaNodeManager", [
      poolManager.address,
      positionManager.address,
      swapRouter.address,
    ]);

    const [walletClient] = await hre.viem.getWalletClients();
    const [sender] = await walletClient.getAddresses();
    const publicClient = await hre.viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    const value = 123n * 10n ** 18n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    await permitToken.write.mint([sender, value]);

    const nonce = (await permitToken.read.nonces([sender])) as bigint;
    const signature = await walletClient.signTypedData({
      account: sender,
      domain: {
        name: "TestTokenPermit",
        version: "1",
        chainId,
        verifyingContract: permitToken.address,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: sender,
        spender: metaNodeManager.address,
        value,
        nonce,
        deadline,
      },
    });
    const { v, r, s } = parseSignature(signature);
    const permitV = Number(v ?? 27n);

    await metaNodeManager.write.selfPermit([
      permitToken.address,
      value,
      deadline,
      permitV,
      r,
      s,
    ]);

    const allowanceAfterPermit = await permitToken.read.allowance([
      sender,
      metaNodeManager.address,
    ]);
    expect(allowanceAfterPermit).to.equal(value);

    const nonceAfterPermit = (await permitToken.read.nonces([sender])) as bigint;
    await metaNodeManager.write.selfPermitIfNecessary([
      permitToken.address,
      value - 1n,
      deadline,
      27,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ]);
    const nonceAfterIfNecessary = (await permitToken.read.nonces([sender])) as bigint;
    expect(nonceAfterIfNecessary).to.equal(nonceAfterPermit);
  });
});
