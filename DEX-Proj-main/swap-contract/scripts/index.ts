/**
 * 从 config 读取合约地址并执行 SwapRouter 测试用例
 *
 * 合约地址来源（按优先级）：
 * 1. 环境变量 CONFIG_PATH 指向的 YAML 文件中的 Contracts 段
 * 2. 下方默认配置（与 sync/config.yaml 格式一致）
 *
 * 使用已部署合约时，需在相同网络运行测试，例如：
 *   CONFIG_PATH=../../sync/config.yaml npx hardhat run scripts/index.ts --network sepolia
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// 默认合约地址（可与 sync/config.yaml 中 Contracts 保持一致，或由 CONFIG_PATH 覆盖）
// ---------------------------------------------------------------------------
const DEFAULT_CONTRACTS = {
  PoolManager: "0xddC12b3F9F7C91C79DA7433D8d212FB78d609f7B",
  PositionManager: "0xbe766Bf20eFfe431829C5d5a2744865974A0B610",
  SwapRouter: "0xD2c220143F5784b3bD84ae12747d97C8A36CeCB2",
};

function parseContractsFromYaml(content: string): Record<string, string> {
  const contracts: Record<string, string> = {};
  const lines = content.split("\n");
  let inContracts = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Contracts:")) {
      inContracts = true;
      continue;
    }
    if (inContracts) {
      if (trimmed.startsWith("#") || trimmed === "") continue;
      const match = trimmed.match(/^(PoolManager|PositionManager|SwapRouter):\s*(0x[a-fA-F0-9]{40})/);
      if (match) contracts[match[1]] = match[2];
    }
  }
  return contracts;
}

function loadContractAddresses(): Record<string, string> {
  const configPath =
    process.env.CONFIG_PATH ||
    path.resolve(__dirname, "../../sync/config.yaml");
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = parseContractsFromYaml(content);
    if (Object.keys(parsed).length >= 3) {
      console.log("使用配置中的合约地址:", configPath);
      return parsed;
    }
  }
  console.log("使用脚本内默认合约地址");
  return DEFAULT_CONTRACTS;
}

async function main() {
  const contracts = loadContractAddresses();
  process.env.POOL_MANAGER_ADDRESS = contracts.PoolManager;
  process.env.POSITION_MANAGER_ADDRESS = contracts.PositionManager;
  process.env.SWAP_ROUTER_ADDRESS = contracts.SwapRouter;

  console.log("==========================================");
  console.log("合约地址:");
  console.log("  PoolManager:", process.env.POOL_MANAGER_ADDRESS);
  console.log("  PositionManager:", process.env.POSITION_MANAGER_ADDRESS);
  console.log("  SwapRouter:", process.env.SWAP_ROUTER_ADDRESS);
  console.log("==========================================");
  console.log("执行测试: test/MetaNodeSwap/SwapRouter.ts\n");

  const testPath = path.resolve(__dirname, "../test/MetaNodeSwap/SwapRouter.ts");
  const args = ["hardhat", "test", testPath];
  if (process.env.HARDHAT_NETWORK) {
    args.push("--network", process.env.HARDHAT_NETWORK);
  }
  const child = spawn(
    "npx",
    args,
    {
      stdio: "inherit",
      shell: true,
      env: { ...process.env },
      cwd: path.resolve(__dirname, ".."),
    }
  );
  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
