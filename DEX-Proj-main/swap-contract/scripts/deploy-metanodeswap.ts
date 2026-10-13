/**
 * 部署 MetaNodeSwap 模块并在 Etherscan 上验证合约源码
 *
 * 使用方式:
 *   npx hardhat run scripts/deploy-metanodeswap.ts --network sepolia
 *
 * 环境变量:
 *   ETHERSCAN_API_KEY - Etherscan API Key（验证必需）
 *
 * 验证逻辑：部署完成后自动调用 hardhat-verify 对 PoolManager、SwapRouter、PositionManager 进行源码验证
 */

import { execSync } from "child_process";
import * as path from "path";

async function main() {
  const network = process.env.HARDHAT_NETWORK || "sepolia";
  const modulePath = "ignition/modules/MetaNodeSwap.ts";

  console.log("========================================");
  console.log("MetaNodeSwap 部署 + 合约验证");
  console.log("网络:", network);
  console.log("========================================\n");

  if (network !== "sepolia" && network !== "mainnet") {
    console.warn("警告: 当前网络可能不支持 Etherscan 验证，请确认 hardhat.config 中已配置 etherscan");
  }

  if (!process.env.ETHERSCAN_API_KEY && (network === "sepolia" || network === "mainnet")) {
    console.error("错误: 验证需要 ETHERSCAN_API_KEY 环境变量");
    console.error("请在 Etherscan 获取 API Key 后设置: export ETHERSCAN_API_KEY=your_key");
    process.exit(1);
  }

  const args = [
    "hardhat",
    "ignition",
    "deploy",
    modulePath,
    "--network",
    network,
    "--verify",
  ];

  console.log("执行: npx", args.join(" "), "\n");
  execSync(`npx ${args.join(" ")}`, {
    stdio: "inherit",
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env },
  });

  console.log("\n部署与验证完成");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
