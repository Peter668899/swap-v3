import hre from "hardhat";
import {
  createWalletClient,
  encodeFunctionData,
  http,
  parseSignature,
  parseAbi,
  parseEther,
  parseGwei,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { encodeSqrtRatioX96, TickMath } from "@uniswap/v3-sdk";

function sortTokens(a: `0x${string}`, b: `0x${string}`) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

async function main() {
  const metaNodeManagerAddress = process.env.META_NODE_MANAGER_ADDRESS as
    | `0x${string}`
    | undefined;
  const weth9Address = process.env.WETH9_ADDRESS as `0x${string}` | undefined;

  if (!metaNodeManagerAddress || !weth9Address) {
    throw new Error(
      "请先在 .env 设置 META_NODE_MANAGER_ADDRESS 和 WETH9_ADDRESS"
    );
  }

  const privateKey = (process.env.PRIVATE_KEY ||
    "0xc3403525339818ca6d633b409c2f8e31d24250b303f97311b3e2b3bc73516c1f") as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  const rpcUrl =
    process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

  const publicClient = await hre.viem.getPublicClient();
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(rpcUrl),
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
    const maxFeePerGas = parseGwei("200");

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

  const metaNodeManager = await hre.viem.getContractAt(
    "MetaNodeManager",
    metaNodeManagerAddress
  );
  const weth9 = await hre.viem.getContractAt("WETH9", weth9Address);

  const managerCode = await publicClient.getCode({ address: metaNodeManagerAddress });
  if (!managerCode || managerCode === "0x") {
    throw new Error(`META_NODE_MANAGER_ADDRESS 不是有效合约: ${metaNodeManagerAddress}`);
  }
  const wethCode = await publicClient.getCode({ address: weth9Address });
  if (!wethCode || wethCode === "0x") {
    throw new Error(`WETH9_ADDRESS 不是有效合约: ${weth9Address}`);
  }

  // 部署测试 USDT（TestTokenPermit）
  const usdt = await hre.viem.deployContract("TestTokenPermit");
  console.log("USDT(TestTokenPermit):", usdt.address);
  console.log("Sender:", account.address);

  const positionManagerAddress = (await metaNodeManager.read.positionManager()) as `0x${string}`;
  const poolManagerAddress = (await metaNodeManager.read.poolManager()) as `0x${string}`;
  const positionManager = await hre.viem.getContractAt(
    "PositionManager",
    positionManagerAddress
  );
  const poolManager = await hre.viem.getContractAt("PoolManager", poolManagerAddress);
  const erc20PermitDetectAbi = parseAbi([
    "function nonces(address owner) view returns (uint256)",
    "function DOMAIN_SEPARATOR() view returns (bytes32)",
  ]);

  const supportsPermit = async (token: `0x${string}`) => {
    try {
      await publicClient.readContract({
        address: token,
        abi: erc20PermitDetectAbi,
        functionName: "nonces",
        args: [account.address],
      });
      await publicClient.readContract({
        address: token,
        abi: erc20PermitDetectAbi,
        functionName: "DOMAIN_SEPARATOR",
      });
      return true;
    } catch {
      return false;
    }
  };

  const token0Token1 = sortTokens(usdt.address, weth9Address);
  const token0 = token0Token1[0];
  const token1 = token0Token1[1];

  const ethAmount = parseEther("0.01");
  const usdtAmount = 3000n * 10n ** 18n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);

  // 准备资产与授权：mint USDT、deposit WETH，授权优先走 permit
  const mintUsdtData = encodeFunctionData({
    abi: usdt.abi,
    functionName: "mint",
    args: [account.address, usdtAmount],
  });
  const mintUsdtTx = await sendRawTx({
    to: usdt.address,
    data: mintUsdtData as `0x${string}`,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintUsdtTx });

  const depositWethTx = await sendRawTx({
    to: weth9Address,
    value: ethAmount,
    data: "0xd0e30db0" as `0x${string}`, // deposit()
  });
  await publicClient.waitForTransactionReceipt({ hash: depositWethTx });

  // allowance 不足才授权；优先 permit，不支持 permit 时一次性 approve(max)
  const ensureMaxAllowance = async (
    token: typeof usdt | typeof weth9,
    tokenAddress: `0x${string}`,
    spender: `0x${string}`,
    minAmount: bigint
  ) => {
    const allowance = (await token.read.allowance([
      account.address,
      spender,
    ])) as bigint;
    if (allowance >= minAmount) {
      console.log(`skip approve, allowance already enough: ${tokenAddress}`);
      return;
    }
    const approveData = encodeFunctionData({
      abi: token.abi,
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
      throw new Error(`approve failed for token: ${tokenAddress}`);
    }
    console.log(`approve max done: ${tokenAddress}`);
  };

  const usdtPermit = await supportsPermit(usdt.address);
  const wethPermit = await supportsPermit(weth9Address);
  console.log("permit support:", {
    usdt: usdtPermit,
    weth9: wethPermit,
  });
  if (usdtPermit) {
    const tokenName = (await usdt.read.name()) as string;
    const nonce = (await publicClient.readContract({
      address: usdt.address,
      abi: parseAbi(["function nonces(address owner) view returns (uint256)"]),
      functionName: "nonces",
      args: [account.address],
    })) as bigint;

    const signature = await walletClient.signTypedData({
      account,
      domain: {
        name: tokenName,
        version: "1",
        chainId: sepolia.id,
        verifyingContract: usdt.address,
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
        owner: account.address,
        spender: metaNodeManagerAddress,
        value: usdtAmount,
        nonce,
        deadline,
      },
    });
    const parsed = parseSignature(signature);
    const permitV = Number(
      parsed.v ?? (parsed.yParity === 0 ? 27 : 28)
    );
    const { r, s } = parsed;
    const selfPermitCall = encodeFunctionData({
      abi: metaNodeManager.abi,
      functionName: "selfPermitIfNecessary",
      args: [usdt.address, usdtAmount, deadline, permitV, r, s],
    }) as `0x${string}`;
    const selfPermitTx = await sendRawTx({
      to: metaNodeManagerAddress,
      data: selfPermitCall,
    });
    const selfPermitReceipt = await publicClient.waitForTransactionReceipt({
      hash: selfPermitTx,
    });
    if (selfPermitReceipt.status !== "success") {
      throw new Error("selfPermitIfNecessary 交易失败");
    }
    console.log("selfPermitIfNecessary tx:", selfPermitTx);
  } else {
    await ensureMaxAllowance(usdt, usdt.address, metaNodeManagerAddress, usdtAmount);
  }

  // Sepolia WETH9 不支持 permit，继续走一次性 approve(max)
  await ensureMaxAllowance(weth9, weth9Address, metaNodeManagerAddress, ethAmount);

  const tickLower = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(1, 1));
  const tickUpper = TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(40000, 1));
  const sqrtPriceX96 = BigInt(encodeSqrtRatioX96(3000, 1).toString());

  const amount0Desired =
    token0.toLowerCase() === weth9Address.toLowerCase() ? ethAmount : usdtAmount;
  const amount1Desired =
    token1.toLowerCase() === weth9Address.toLowerCase() ? ethAmount : usdtAmount;

  const createPoolCall = encodeFunctionData({
    abi: metaNodeManager.abi,
    functionName: "createPool",
    args: [
      {
        token0,
        token1,
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
        token0,
        token1,
        index: 0,
        amount0Desired,
        amount1Desired,
        recipient: account.address,
        deadline,
      },
    ],
  });

  const nftBefore = (await positionManager.read.balanceOf([account.address])) as bigint;

  const multicallData = encodeFunctionData({
    abi: metaNodeManager.abi,
    functionName: "multicall",
    args: [[createPoolCall, addLiquidityCall]],
  });

  const multicallTx = await sendRawTx({
    to: metaNodeManagerAddress,
    data: multicallData as `0x${string}`,
  });
  console.log("multicall tx:", multicallTx);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: multicallTx });
  if (receipt.status !== "success") {
    throw new Error("MetaNodeManager.multicall 交易失败");
  }

  const allPools = await poolManager.read.getAllPools();
  const targetPools = allPools.filter(
    (p) =>
      p.token0.toLowerCase() === token0.toLowerCase() &&
      p.token1.toLowerCase() === token1.toLowerCase()
  );
  if (targetPools.length === 0) {
    throw new Error("交易成功但未找到 ETH/USDT 池");
  }
  const poolAddress = targetPools[0].pool;

  const wethInPool = (await weth9.read.balanceOf([poolAddress])) as bigint;
  const usdtInPool = (await usdt.read.balanceOf([poolAddress])) as bigint;
  const nftAfter = (await positionManager.read.balanceOf([account.address])) as bigint;

  console.log("pool:", poolAddress);
  console.log("position NFT delta:", (nftAfter - nftBefore).toString());
  console.log("WETH in pool:", wethInPool.toString());
  console.log("USDT in pool:", usdtInPool.toString());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
