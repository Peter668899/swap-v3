import { NextResponse } from 'next/server'
import { createPublicClient, http, formatUnits } from 'viem'
import { sepolia } from 'viem/chains'
import { getTokenByAddress, isNativeTokenAddress, TOKENS, toChainTokenAddress } from '@/lib/constants'
import { contractConfig } from '@/lib/contracts'

// 创建公共客户端连接
const client = createPublicClient({
  chain: sepolia,
  transport: http(process.env.SEPOLIA_RPC_URL || 'https://sepolia.infura.io/v3/3fb192ba9f724e6497fff0a0abd04f98'),
})

export async function POST(request: Request) {
  try {
    // 解析请求数据
    const body = await request.json()
    const { poolAddress, inputToken, inputAmount } = body

    if (!poolAddress || !inputToken || !inputAmount) {
      return NextResponse.json(
        { success: false, error: '缺少必要参数' },
        { status: 400 }
      )
    }

    // 获取池子的token0和token1
    const token0 = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: contractConfig.pool.abi,
      functionName: 'token0',
    }) as `0x${string}`

    const token1 = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: contractConfig.pool.abi,
      functionName: 'token1',
    }) as `0x${string}`

    // 找到代币信息
    const getTokenInfo = (address: string) => {
      const token = getTokenByAddress(address)
      return token || { symbol: 'UNKNOWN', name: 'Unknown Token', decimals: 18 }
    }

    const token0Info = getTokenInfo(token0)
    const token1Info = getTokenInfo(token1)

    const isToken0ETH = isNativeTokenAddress(token0)
    const isToken1ETH = isNativeTokenAddress(token1)

    // 获取池子余额的辅助函数
    const getTokenBalance = async (tokenAddress: string, isETH: boolean, tokenInfo: any): Promise<bigint> => {
      if (isETH) {
        const wethAddress = toChainTokenAddress(tokenAddress)

        return await client.readContract({
          address: wethAddress as `0x${string}`,
          abi: contractConfig.erc20.abi,
          functionName: 'balanceOf',
          args: [poolAddress as `0x${string}`],
        }) as bigint
      } else {
        // ERC20 代币，使用 balanceOf
        return await client.readContract({
          address: tokenAddress as `0x${string}`,
          abi: contractConfig.erc20.abi,
          functionName: 'balanceOf',
          args: [poolAddress as `0x${string}`],
        }) as bigint
      }
    }

    // 获取池子余额
    const token0Balance = await getTokenBalance(token0, isToken0ETH, token0Info)
    const token1Balance = await getTokenBalance(token1, isToken1ETH, token1Info)

    // 计算价格比例
    const token0BalanceFormatted = parseFloat(formatUnits(token0Balance, token0Info.decimals))
    const token1BalanceFormatted = parseFloat(formatUnits(token1Balance, token1Info.decimals))
    
    // 如果池子没有流动性，使用1:1比例
    if (token0BalanceFormatted === 0 || token1BalanceFormatted === 0) {
      return NextResponse.json({
        success: true,
        outputAmount: inputAmount,
      })
    }

    // 计算价格比例
    const priceRatio = token1BalanceFormatted / token0BalanceFormatted
    
    // 计算输出金额
    let outputAmount
    if (inputToken.toLowerCase() === token0.toLowerCase()) {
      // 如果输入是token0，输出是token1
      outputAmount = parseFloat(inputAmount) * priceRatio
    } else {
      // 如果输入是token1，输出是token0
      outputAmount = parseFloat(inputAmount) / priceRatio
    }

    return NextResponse.json({
      success: true,
      outputAmount: outputAmount.toString(),
      priceRatio: priceRatio.toString(),
    })
  } catch (error: unknown) {
    console.error('计算价格API错误:', error)
    
    const errorMessage = error instanceof Error ? error.message : '计算价格失败'
    
    return NextResponse.json({
      success: false,
      error: errorMessage,
      msg: errorMessage,
    }, { status: 500 })
  }
} 