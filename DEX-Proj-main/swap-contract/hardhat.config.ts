import { HardhatUserConfig } from "hardhat/config";
import { config as dotenvConfig } from "dotenv";
import "@nomicfoundation/hardhat-toolbox-viem";
import "@nomicfoundation/hardhat-verify";
import "hardhat-gas-reporter"

dotenvConfig();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
      viaIR: true
    },
  },
  defaultNetwork: "hardhat",
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
      // accounts: ["c3403525339818ca6d633b409c2f8e31d24250b303f97311b3e2b3bc73516c1f"],
    },
    sepolia: {
      url:
        process.env.SEPOLIA_RPC_URL ||
        "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: [
        (process.env.PRIVATE_KEY ||
          "c3403525339818ca6d633b409c2f8e31d24250b303f97311b3e2b3bc73516c1f"
        ).replace(/^0x/, ""),
      ],
    },
  },
  // 使用单 API Key 启用 Etherscan API V2（V1 已弃用）
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "5FCIE4WK4IU1DNCAGGBXNZJPK49YMIS5FT",
  },
};

module.exports = {
  default: config,
  gasReporter: {
    enable: true,
    currency: '$'
  }
}
