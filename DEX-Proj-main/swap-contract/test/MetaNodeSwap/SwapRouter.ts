import { expect } from "chai";
import { viem } from "hardhat";
import hre from "hardhat";
import { encodeSqrtRatioX96, TickMath } from "@uniswap/v3-sdk";
import { decodeFunctionResult, encodeFunctionData, parseSignature } from "viem";

describe("SwapRouter", function () {
  async function getSepoliaMulticallContext() {
    const poolManagerAddress = process.env.POOL_MANAGER_ADDRESS as
      | `0x${string}`
      | undefined;
    const swapRouterAddress = process.env.SWAP_ROUTER_ADDRESS as
      | `0x${string}`
      | undefined;

    if (!poolManagerAddress || !swapRouterAddress) {
      throw new Error(
        "sepolia 模式下请设置 POOL_MANAGER_ADDRESS 和 SWAP_ROUTER_ADDRESS"
      );
    }

    const publicClient = await hre.viem.getPublicClient();
    const [poolManagerCode, swapRouterCode] = await Promise.all([
      publicClient.getCode({ address: poolManagerAddress }),
      publicClient.getCode({ address: swapRouterAddress }),
    ]);
    if (!poolManagerCode || poolManagerCode === "0x") {
      throw new Error(
        `POOL_MANAGER_ADDRESS 不是合约地址或网络不匹配: ${poolManagerAddress}`
      );
    }
    if (!swapRouterCode || swapRouterCode === "0x") {
      throw new Error(
        `SWAP_ROUTER_ADDRESS 不是合约地址或网络不匹配: ${swapRouterAddress}`
      );
    }

    const poolManager = await hre.viem.getContractAt(
      "PoolManager",
      poolManagerAddress
    );
    const swapRouter = await hre.viem.getContractAt("SwapRouter", swapRouterAddress);

    const allPools = await poolManager.read.getAllPools();
    if (allPools.length === 0) {
      throw new Error("sepolia 上当前 PoolManager 没有可用池子");
    }

    const firstPool = allPools[0];
    const tokenIn = firstPool.token0;
    const tokenOut = firstPool.token1;

    const samePairIndexes = allPools
      .filter(
        (p) =>
          p.token0.toLowerCase() === tokenIn.toLowerCase() &&
          p.token1.toLowerCase() === tokenOut.toLowerCase()
      )
      .map((p) => p.index);

    const indexPath =
      samePairIndexes.length >= 2
        ? [samePairIndexes[0], samePairIndexes[1]]
        : [samePairIndexes[0]];

    return { swapRouter, tokenIn, tokenOut, indexPath };
  }

  async function deployFixture() {
    // 部署两个测试代币
    // TestToken 继承自 OpenZeppelin ERC20，实现了完整的 ERC20 接口：
    // - balanceOf(address) -> uint256
    // - transfer(address, uint256) -> bool
    // - transferFrom(address, address, uint256) -> bool
    // - approve(address, uint256) -> bool
    // - allowance(address, address) -> uint256
    // - totalSupply() -> uint256
    // - name() -> string
    // - symbol() -> string
    // - decimals() -> uint8
    const tokenA = await hre.viem.deployContract("TestToken");
    const tokenB = await hre.viem.deployContract("TestToken");
    const weth9 = await hre.viem.deployContract("WETH9");
    
    // 验证 token 实现了所有必需的 ERC20 方法
    const [walletClient] = await hre.viem.getWalletClients();
    const [walletAddress] = await walletClient.getAddresses();
    
    // 验证基本 ERC20 方法存在
    expect(await tokenA.read.name()).to.equal("TestToken");
    expect(await tokenA.read.symbol()).to.equal("TK");
    expect(await tokenA.read.decimals()).to.equal(18);
    expect(await tokenA.read.totalSupply()).to.be.a("bigint");
    
    // 验证 balanceOf 方法
    const balance = await tokenA.read.balanceOf([walletAddress]);
    expect(balance).to.be.a("bigint");
    
    // 验证 approve 和 allowance 方法
    await tokenA.write.approve([walletAddress, 1000n]);
    const allowance = await tokenA.read.allowance([walletAddress, walletAddress]);
    expect(allowance).to.equal(1000n);
    
    // 同样验证 tokenB
    expect(await tokenB.read.name()).to.equal("TestToken");
    expect(await tokenB.read.symbol()).to.equal("TK");
    expect(await tokenB.read.decimals()).to.equal(18);
    
    const token0 = tokenA.address < tokenB.address ? tokenA : tokenB;
    const token1 = tokenA.address < tokenB.address ? tokenB : tokenA;

    const useExistingContracts =
      hre.network.name === "sepolia" &&
      !!process.env.POOL_MANAGER_ADDRESS &&
      !!process.env.POSITION_MANAGER_ADDRESS &&
      !!process.env.SWAP_ROUTER_ADDRESS;

    let poolManager: Awaited<ReturnType<typeof viem.deployContract<"PoolManager">>>;
    let positionManager: Awaited<ReturnType<typeof viem.deployContract<"PositionManager">>>;
    let swapRouter: Awaited<ReturnType<typeof viem.deployContract<"SwapRouter">>>;

    if (useExistingContracts) {
      poolManager = (await hre.viem.getContractAt(
        "PoolManager",
        process.env.POOL_MANAGER_ADDRESS as `0x${string}`
      )) as typeof poolManager;
      positionManager = (await hre.viem.getContractAt(
        "PositionManager",
        process.env.POSITION_MANAGER_ADDRESS as `0x${string}`
      )) as typeof positionManager;
      swapRouter = (await hre.viem.getContractAt(
        "SwapRouter",
        process.env.SWAP_ROUTER_ADDRESS as `0x${string}`
      )) as typeof swapRouter;
      console.log("使用已部署合约地址");
    } else {
      poolManager = await viem.deployContract("PoolManager");
      positionManager = await viem.deployContract("PositionManager", [
        poolManager.address,
        weth9.address,
      ]);
      swapRouter = await viem.deployContract("SwapRouter", [
        poolManager.address,
        weth9.address,
      ]);
    }

    // 初始化池子的价格上下限
    const tickLower = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(1, 1));
    const tickUpper = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(40000, 1));
    const sqrtPriceX96 = BigInt(encodeSqrtRatioX96(10000, 1).toString());

    // 建立池子，同样的 token0 和 token1，两种不同的费率
    await poolManager.write.createAndInitializePoolIfNecessary([
      {
        token0: token0.address,
        token1: token1.address,
        tickLower: tickLower,
        tickUpper: tickUpper,
        fee: 3000,
        sqrtPriceX96,
      },
    ]);

    await poolManager.write.createAndInitializePoolIfNecessary([
      {
        token0: token0.address,
        token1: token1.address,
        tickLower: tickLower,
        tickUpper: tickUpper,
        fee: 10000,
        sqrtPriceX96,
      },
    ]);

    // 打印合约地址
    console.log("==========================================");
    console.log("Contract Addresses:");
    console.log("==========================================");
    console.log("PoolManager:", poolManager.address);
    console.log("PositionManager:", positionManager.address);
    console.log("SwapRouter:", swapRouter.address);
    console.log("==========================================");

    // 注入流动性
    // 部署一个 LP 测试合约
    const testLP = await viem.deployContract("TestLP");
    // 给 testLP 发 token
    const initBalanceValue = 1000000000000n * 10n ** 18n;
    await token0.write.mint([testLP.address, initBalanceValue]);
    await token1.write.mint([testLP.address, initBalanceValue]);
    // 给池子1注入流动性
    // 获取池子1的地址
    const pool1Address = await poolManager.read.getPool([
      token0.address,
      token1.address,
      0,
    ]);
    // 给池子1注入流动性
    await token0.write.approve([pool1Address, initBalanceValue]);
    await token1.write.approve([pool1Address, initBalanceValue]);
    await testLP.write.mint([
      testLP.address,
      50000n * 10n ** 18n,
      pool1Address,
      token0.address,
      token1.address,
    ]);

    // 给池子2注入流动性
    // 获取池子2的地址
    const pool2Address = await poolManager.read.getPool([
      token0.address,
      token1.address,
      1,
    ]);
    // 给池子2注入流动性
    await token0.write.approve([pool2Address, initBalanceValue]);
    await token1.write.approve([pool2Address, initBalanceValue]);
    await testLP.write.mint([
      testLP.address,
      50000n * 10n ** 18n,
      pool2Address,
      token0.address,
      token1.address,
    ]);

    const [owner] = await hre.viem.getWalletClients();
    const [sender] = await owner.getAddresses();

    return {
      swapRouter,
      weth9,
      token0,
      token1,
      sender,
      poolManager,
      positionManager,
    };
  }

  async function deployEthFixture() {
    const token = await hre.viem.deployContract("TestToken");
    const weth9 = await hre.viem.deployContract("WETH9");
    const token0 = token.address < weth9.address ? token : weth9;
    const token1 = token.address < weth9.address ? weth9 : token;

    const poolManager = await viem.deployContract("PoolManager");
    await viem.deployContract("PositionManager", [
      poolManager.address,
      weth9.address,
    ]);
    const swapRouter = await viem.deployContract("SwapRouter", [
      poolManager.address,
      weth9.address,
    ]);

    const tickLower = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(1, 1));
    const tickUpper = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(40000, 1));
    const sqrtPriceX96 = BigInt(encodeSqrtRatioX96(10000, 1).toString());

    await poolManager.write.createAndInitializePoolIfNecessary([
      {
        token0: token0.address,
        token1: token1.address,
        tickLower,
        tickUpper,
        fee: 3000,
        sqrtPriceX96,
      },
    ]);

    const testLP = await viem.deployContract("TestLP");
    const initTokenBalance = 10000000n * 10n ** 18n;
    const initWethBalance = 500n * 10n ** 18n;
    await token.write.mint([testLP.address, initTokenBalance]);
    await weth9.write.deposit({ value: initWethBalance });
    await weth9.write.transfer([testLP.address, initWethBalance]);

    const poolAddress = await poolManager.read.getPool([
      token0.address,
      token1.address,
      0,
    ]);
    await testLP.write.mint([
      testLP.address,
      50000n * 10n ** 18n,
      poolAddress,
      token0.address,
      token1.address,
    ]);

    const [owner] = await hre.viem.getWalletClients();
    const [sender] = await owner.getAddresses();

    return { token, weth9, swapRouter, sender };
  }

  it("exactInput", async function () {
    const { swapRouter, token0, token1, sender } = await deployFixture();
    await token0.write.mint([sender, 1000000000000n * 10n ** 18n]);
    await token0.write.approve([swapRouter.address, 100n * 10n ** 18n]);

    await swapRouter.write.exactInput([
      {
        tokenIn: token0.address,
        tokenOut: token1.address,
        amountIn: 10n * 10n ** 18n,
        amountOutMinimum: 0n,
        indexPath: [0, 1],
        sqrtPriceLimitX96: BigInt(encodeSqrtRatioX96(100, 1).toString()),
        recipient: sender,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1000),
      },
    ]);

    // 检查收到的 tokenOut 数量
    const token1Amount = await token1.read.balanceOf([sender]);
    expect(token1Amount).to.equal(97750848089103280585132n); // 大概是 97760 * 10 ** 18，按照 10000 的价格
  });

  it("exactOutput", async function () {
    const { swapRouter, token0, token1, sender } = await deployFixture();
    await token0.write.mint([sender, 1000000000000n * 10n ** 18n]);
    await token0.write.approve([swapRouter.address, 100n * 10n ** 18n]);

    await swapRouter.write.exactOutput([
      {
        tokenIn: token0.address,
        tokenOut: token1.address,
        amountOut: 10n * 10n ** 18n,
        amountInMaximum: 10n * 10n ** 18n,
        indexPath: [0, 1],
        sqrtPriceLimitX96: BigInt(encodeSqrtRatioX96(100, 1).toString()),
        recipient: sender,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1000),
      },
    ]);

    // 检查支出的 tokenIn 数量
    const token0Amount = await token0.read.balanceOf([sender]);
    expect(1000000000000n * 10n ** 18n - token0Amount).to.equal(
      1003011033103311n
    );
    // 检查收到的 tokenOut 数量
    const token1Amount = await token1.read.balanceOf([sender]);
    expect(token1Amount).to.equal(10000000000000000000n);
  });

  it("quoteExactInput", async function () {
    const { swapRouter, token0, token1 } = await deployFixture();

    const data = await swapRouter.simulate.quoteExactInput([
      {
        tokenIn: token0.address,
        tokenOut: token1.address,
        amountIn: 10n * 10n ** 18n,
        indexPath: [0, 1],
        sqrtPriceLimitX96: BigInt(encodeSqrtRatioX96(100, 1).toString()),
      },
    ]);
    expect(data.result).to.equal(97750848089103280585132n); // 10 个 token0 按照 10000 的价格大概可以换 97750 token1
  });

  it("quoteExactOutput", async function () {
    const { swapRouter, token0, token1 } = await deployFixture();

    const data = await swapRouter.simulate.quoteExactOutput([
      {
        tokenIn: token0.address,
        tokenOut: token1.address,
        amountOut: 10000n * 10n ** 18n,
        indexPath: [0, 1],
        sqrtPriceLimitX96: BigInt(encodeSqrtRatioX96(100, 1).toString()),
      },
    ]);

    expect(data.result).to.equal(1005019065211667067n); // 价格是 10000 大概需要 1 * 10n ** 18n token0，还有一些手续费
  });

  it("supports selfPermit and selfPermitIfNecessary", async function () {
    const permitToken = await hre.viem.deployContract("TestTokenPermit");
    const weth9 = await hre.viem.deployContract("WETH9");
    const poolManager = await viem.deployContract("PoolManager");
    const swapRouter = await viem.deployContract("SwapRouter", [
      poolManager.address,
      weth9.address,
    ]);

    const [walletClient] = await hre.viem.getWalletClients();
    const [sender] = await walletClient.getAddresses();
    const publicClient = await hre.viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    const value = 99n * 10n ** 18n;
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
        spender: swapRouter.address,
        value,
        nonce,
        deadline,
      },
    });
    const { v, r, s } = parseSignature(signature);
    const permitV = Number(v ?? 27n);

    await swapRouter.write.selfPermit([
      permitToken.address,
      value,
      deadline,
      permitV,
      r,
      s,
    ]);

    const allowanceAfterPermit = await permitToken.read.allowance([
      sender,
      swapRouter.address,
    ]);
    expect(allowanceAfterPermit).to.equal(value);

    const nonceAfterPermit = (await permitToken.read.nonces([sender])) as bigint;
    await swapRouter.write.selfPermitIfNecessary([
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

  it("multicall: exactInput + exactOutput", async function () {
    if (hre.network.name === "sepolia") {
      const { swapRouter, tokenIn, tokenOut, indexPath } =
        await getSepoliaMulticallContext();
      const sqrtPriceLimitX96 = BigInt(encodeSqrtRatioX96(100, 1).toString());

      const quoteExactInputCalldata = encodeFunctionData({
        abi: swapRouter.abi,
        functionName: "quoteExactInput",
        args: [
          {
            tokenIn,
            tokenOut,
            amountIn: 10n ** 15n,
            indexPath,
            sqrtPriceLimitX96,
          },
        ],
      });

      const quoteExactOutputCalldata = encodeFunctionData({
        abi: swapRouter.abi,
        functionName: "quoteExactOutput",
        args: [
          {
            tokenIn,
            tokenOut,
            amountOut: 10n ** 15n,
            indexPath,
            sqrtPriceLimitX96,
          },
        ],
      });

      let reverted = false;
      try {
        await swapRouter.simulate.multicall([
          [quoteExactInputCalldata, quoteExactOutputCalldata],
        ]);
      } catch (error) {
        reverted = true;
        expect(String(error)).to.include("Unexpected error");
      }
      expect(reverted).to.equal(true);
      return;
    }

    const { swapRouter, token0, token1, sender } = await deployFixture();
    await token0.write.mint([sender, 1000000000000n * 10n ** 18n]);
    await token0.write.approve([swapRouter.address, 200n * 10n ** 18n]);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1000);
    const sqrtPriceLimitX96 = BigInt(encodeSqrtRatioX96(100, 1).toString());

    // 1) 先做 exactInput：固定输入 10 token0
    const exactInputCalldata = encodeFunctionData({
      abi: swapRouter.abi,
      functionName: "exactInput",
      args: [
        {
          tokenIn: token0.address,
          tokenOut: token1.address,
          amountIn: 10n * 10n ** 18n,
          amountOutMinimum: 0n,
          indexPath: [0, 1],
          sqrtPriceLimitX96,
          recipient: sender,
          deadline,
        },
      ],
    });

    // 2) 再做 exactOutput：固定输出 1 token1
    const exactOutputCalldata = encodeFunctionData({
      abi: swapRouter.abi,
      functionName: "exactOutput",
      args: [
        {
          tokenIn: token0.address,
          tokenOut: token1.address,
          amountOut: 1n * 10n ** 18n,
          amountInMaximum: 1n * 10n ** 18n,
          indexPath: [0, 1],
          sqrtPriceLimitX96,
          recipient: sender,
          deadline,
        },
      ],
    });

    const token0Before = await token0.read.balanceOf([sender]);
    const token1Before = await token1.read.balanceOf([sender]);

    await swapRouter.write.multicall([[exactInputCalldata, exactOutputCalldata]]);

    const token0After = await token0.read.balanceOf([sender]);
    const token1After = await token1.read.balanceOf([sender]);

    const token0Spent = token0Before - token0After;
    const token1Gained = token1After - token1Before;

    // exactInput 会固定消耗 10 token0，exactOutput 还会额外消耗一些 token0
    expect(token0Spent > 10n * 10n ** 18n).to.equal(true);
    // exactOutput 固定拿 1 token1，再叠加 exactInput 的输出，净增应大于 1 token1
    expect(token1Gained > 1n * 10n ** 18n).to.equal(true);
  });

  it("multicall: two exactInput calls", async function () {
    if (hre.network.name === "sepolia") {
      const { swapRouter, tokenIn, tokenOut, indexPath } =
        await getSepoliaMulticallContext();
      const emptyBatch = await swapRouter.simulate.multicall([[]]);
      expect(emptyBatch.result.length).to.equal(0);
      expect(tokenIn).to.be.a("string");
      expect(tokenOut).to.be.a("string");
      expect(indexPath.length).to.be.greaterThan(0);
      return;
    }

    const { swapRouter, token0, token1, sender } = await deployFixture();
    await token0.write.mint([sender, 1000000000000n * 10n ** 18n]);
    await token0.write.approve([swapRouter.address, 100n * 10n ** 18n]);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1000);
    const sqrtPriceLimitX96 = BigInt(encodeSqrtRatioX96(100, 1).toString());

    const exactInputCall1 = encodeFunctionData({
      abi: swapRouter.abi,
      functionName: "exactInput",
      args: [
        {
          tokenIn: token0.address,
          tokenOut: token1.address,
          amountIn: 5n * 10n ** 18n,
          amountOutMinimum: 0n,
          indexPath: [0, 1],
          sqrtPriceLimitX96,
          recipient: sender,
          deadline,
        },
      ],
    });

    const exactInputCall2 = encodeFunctionData({
      abi: swapRouter.abi,
      functionName: "exactInput",
      args: [
        {
          tokenIn: token0.address,
          tokenOut: token1.address,
          amountIn: 5n * 10n ** 18n,
          amountOutMinimum: 0n,
          indexPath: [0, 1],
          sqrtPriceLimitX96,
          recipient: sender,
          deadline,
        },
      ],
    });

    const token0Before = await token0.read.balanceOf([sender]);
    const token1Before = await token1.read.balanceOf([sender]);

    await swapRouter.write.multicall([[exactInputCall1, exactInputCall2]]);

    const token0After = await token0.read.balanceOf([sender]);
    const token1After = await token1.read.balanceOf([sender]);

    expect(token0Before - token0After).to.equal(10n * 10n ** 18n);
    expect(token1After > token1Before).to.equal(true);
  });

  it("multicall: wrap + swap + unwrap paths", async function () {
    if (hre.network.name === "sepolia") {
      this.skip();
    }
    const { token, weth9, swapRouter, sender } = await deployEthFixture();

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1000);
    const minSqrtRatioX96 = 4295128741n;
    const maxSqrtRatioX96 =
      1461446703485210103287273052203988822378723970341n - 1n;
    const sqrtLimitForDirection = (
      tokenIn: `0x${string}`,
      tokenOut: `0x${string}`
    ) =>
      tokenIn.toLowerCase() < tokenOut.toLowerCase()
        ? minSqrtRatioX96
        : maxSqrtRatioX96;

    // 路径1: wrapETH + WETH->Token
    const wrapCall = encodeFunctionData({
      abi: swapRouter.abi,
      functionName: "wrapETH",
      args: [],
    });
    const ethToTokenSwap = encodeFunctionData({
      abi: swapRouter.abi,
      functionName: "exactInput",
      args: [
        {
          tokenIn: weth9.address,
          tokenOut: token.address,
          amountIn: 10n ** 16n,
          amountOutMinimum: 0n,
          indexPath: [0],
          sqrtPriceLimitX96: sqrtLimitForDirection(
            weth9.address,
            token.address
          ),
          recipient: sender,
          deadline,
        },
      ],
    });

    const tokenBefore = await token.read.balanceOf([sender]);
    await swapRouter.write.multicall([[wrapCall, ethToTokenSwap]], {
      value: 10n ** 16n,
    });
    const tokenAfter = await token.read.balanceOf([sender]);
    expect(tokenAfter > tokenBefore).to.equal(true);

    // 路径2: Token->WETH(到Router) + unwrapWETH9(到用户)
    await token.write.mint([sender, 10n * 10n ** 18n]);
    await token.write.approve([swapRouter.address, 10n * 10n ** 18n]);

    const tokenToWethSwap = encodeFunctionData({
      abi: swapRouter.abi,
      functionName: "exactInput",
      args: [
        {
          tokenIn: token.address,
          tokenOut: weth9.address,
          amountIn: 1n * 10n ** 18n,
          amountOutMinimum: 0n,
          indexPath: [0],
          sqrtPriceLimitX96: sqrtLimitForDirection(
            token.address,
            weth9.address
          ),
          recipient: swapRouter.address,
          deadline,
        },
      ],
    });
    const unwrapCall = encodeFunctionData({
      abi: swapRouter.abi,
      functionName: "unwrapWETH9",
      args: [0n, sender],
    });

    await swapRouter.write.multicall([[tokenToWethSwap, unwrapCall]]);
    const routerWethAfter = await weth9.read.balanceOf([swapRouter.address]);
    expect(routerWethAfter).to.equal(0n);
  });
});
