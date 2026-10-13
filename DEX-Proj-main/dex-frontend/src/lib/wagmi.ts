import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { sepolia } from 'wagmi/chains'
import { http } from 'wagmi'

// 配置支持的链
export const config = getDefaultConfig({
  appName: 'MetaNodeSwap',
  projectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || 'YOUR_PROJECT_ID', // 可选，用于 WalletConnect
  chains: [sepolia],
  transports: {
    [sepolia.id]: http(process.env.SEPOLIA_RPC_URL || 'https://sepolia.infura.io/v3/3fb192ba9f724e6497fff0a0abd04f98'),
  },
  ssr: true, // 如果你的 dApp 使用服务器端渲染 (SSR)
})

export { sepolia } 