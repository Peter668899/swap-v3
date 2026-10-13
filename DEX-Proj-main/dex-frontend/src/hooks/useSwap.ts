import { useState, useCallback } from 'react'
import {
  useAccount,
  useWriteContract,
  useReadContract,
  useWaitForTransactionReceipt,
  usePublicClient,
  useSignTypedData,
} from 'wagmi'
import { parseUnits, formatUnits, encodeFunctionData, parseSignature } from 'viem'
import { contractConfig, ERC20_ABI } from '@/lib/contracts'
import { TOKENS } from '@/lib/constants'

export interface SwapParams {
  tokenIn: string
  tokenOut: string
  amountIn: string
  slippage: number
  indexPath?: number[]
  tokenInDecimals?: number
  tokenOutDecimals?: number
  tokenInName?: string
  tokenInSupportsPermit?: boolean
}

interface QuoteResult {
  amountOut: string
  priceImpact: string
  simulated: boolean
  indexPathUsed?: number[]
}

const GAS_LIMIT_CAP = 16_000_000n
const SWAP_GAS_FALLBACK = 4_000_000n
const APPROVE_GAS_FALLBACK = 120_000n
const MIN_SQRT_PRICE = 4295128739n
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n
const LEGACY_WETH_ADDRESS = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14'

const ERC20_PERMIT_ABI = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export function useSwap() {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContract, data: hash, isPending } = useWriteContract()
  const [lastSwapParams, setLastSwapParams] = useState<SwapParams | null>(null)

  const isEthLikeToken = useCallback((tokenAddress: string) => {
    const normalized = tokenAddress.toLowerCase()
    return (
      normalized === TOKENS.ETH.address.toLowerCase() ||
      normalized === TOKENS.ETH.wrappedAddress.toLowerCase()
    )
  }, [])

  const getEthLikeAliases = useCallback((tokenAddress: string) => {
    if (!isEthLikeToken(tokenAddress)) {
      return [tokenAddress.toLowerCase()]
    }
    return Array.from(new Set([
      TOKENS.ETH.wrappedAddress.toLowerCase(),
      LEGACY_WETH_ADDRESS,
    ]))
  }, [isEthLikeToken])

  const getDefaultSqrtPriceLimit = useCallback((tokenIn: string, tokenOut: string): bigint => {
    const zeroForOne = tokenIn.toLowerCase() < tokenOut.toLowerCase()
    return zeroForOne ? (MIN_SQRT_PRICE + 1n) : (MAX_SQRT_PRICE - 1n)
  }, [])

  const resolveAvailableRoute = useCallback(async (tokenA: string, tokenB: string) => {
    if (!publicClient) {
      return {
        tokenIn: tokenA,
        tokenOut: tokenB,
        indexPath: [] as number[],
      }
    }

    const pools = (await publicClient.readContract({
      address: contractConfig.poolManager.address,
      abi: contractConfig.poolManager.abi,
      functionName: 'getAllPools',
    })) as readonly { token0: `0x${string}`; token1: `0x${string}`; index: number | bigint; liquidity?: bigint }[]

    const aAliases = new Set(getEthLikeAliases(tokenA))
    const bAliases = new Set(getEthLikeAliases(tokenB))

    const matchedPools = Array.from(pools).filter((pool) => {
      const p0 = pool.token0.toLowerCase()
      const p1 = pool.token1.toLowerCase()
      return (aAliases.has(p0) && bAliases.has(p1)) || (aAliases.has(p1) && bAliases.has(p0))
    })

    if (matchedPools.length === 0) {
      return {
        tokenIn: tokenA,
        tokenOut: tokenB,
        indexPath: [] as number[],
      }
    }

    const preferredPool = matchedPools[0]
    const preferredToken0 = preferredPool.token0.toLowerCase()
    const preferredToken1 = preferredPool.token1.toLowerCase()
    const tokenInResolved =
      aAliases.has(preferredToken0) && bAliases.has(preferredToken1)
        ? preferredPool.token0
        : preferredPool.token1
    const tokenOutResolved =
      tokenInResolved.toLowerCase() === preferredPool.token0.toLowerCase()
        ? preferredPool.token1
        : preferredPool.token0

    const indexPath = matchedPools
      .filter((pool) => {
        const p0 = pool.token0.toLowerCase()
        const p1 = pool.token1.toLowerCase()
        return (
          (p0 === tokenInResolved.toLowerCase() && p1 === tokenOutResolved.toLowerCase()) ||
          (p0 === tokenOutResolved.toLowerCase() && p1 === tokenInResolved.toLowerCase())
        )
      })
      .map((pool) => Number(pool.index))

    return {
      tokenIn: tokenInResolved,
      tokenOut: tokenOutResolved,
      indexPath,
    }
  }, [getEthLikeAliases, publicClient])

  const estimateGasWithCap = useCallback(async (request: {
    address: `0x${string}`
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
    value?: bigint
    fallbackGas: bigint
  }) => {
    if (!publicClient || !address) return request.fallbackGas
    try {
      const estimated = await publicClient.estimateContractGas({
        address: request.address,
        abi: request.abi as any,
        functionName: request.functionName as any,
        args: request.args as any,
        value: request.value,
        account: address as `0x${string}`,
      })
      const buffered = (estimated * 12n) / 10n
      return buffered > GAS_LIMIT_CAP ? GAS_LIMIT_CAP : buffered
    } catch (error) {
      console.warn(`Gas estimate failed for ${request.functionName}, fallback to ${request.fallbackGas.toString()}`, error)
      return request.fallbackGas
    }
  }, [address, publicClient])

  // 等待交易确认
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash,
  })

  // 获取价格预估 - 使用合约调用
  const getQuote = useCallback(async (params: SwapParams): Promise<QuoteResult | null> => {
    if (!params.amountIn || parseFloat(params.amountIn) === 0) {
      return null
    }

    try {
      // decimals 优先使用上层传入值，其次本地常量，最后兜底 18。
      const tokenInObj = Object.values(TOKENS).find(t => t.address.toLowerCase() === params.tokenIn.toLowerCase())
      const tokenInDecimals = params.tokenInDecimals ?? tokenInObj?.decimals ?? 18

      // 只有在没有从上层传入 decimals 且本地常量也找不到时，才降级到 18。
      if (params.tokenInDecimals == null && !tokenInObj) {
        console.debug(`Token ${params.tokenIn} not found in local config, fallback to 18 decimals`)
      }

      const amountInWei = parseUnits(params.amountIn, tokenInDecimals)
      const actualTokenIn = isEthLikeToken(params.tokenIn)
        ? TOKENS.ETH.wrappedAddress
        : params.tokenIn
      const actualTokenOut = isEthLikeToken(params.tokenOut)
        ? TOKENS.ETH.wrappedAddress
        : params.tokenOut
      const sqrtPriceLimitX96 = getDefaultSqrtPriceLimit(actualTokenIn, actualTokenOut)

      // 由后端 quote 统一选池并返回结果（含 indexPathUsed）。
      const result = await fetch('/api/quote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tokenIn: actualTokenIn,
          tokenOut: actualTokenOut,
          amountIn: amountInWei.toString(),
          indexPath: params.indexPath ?? [0],
          sqrtPriceLimitX96: sqrtPriceLimitX96.toString(),
        }),
      }).then(res => res.json())
      
      if (result.error) {
        // 业务错误（比如未找到交易对）不抛异常，返回 null 让调用方做友好提示。
        const errorMessage = result.msg || result.error || '获取报价失败'
        console.warn('Quote unavailable:', errorMessage)
        return null
      }

      let tokenOutDecimals = params.tokenOutDecimals ?? 18
      const tokenOutObj = Object.values(TOKENS).find(t => t.address.toLowerCase() === params.tokenOut.toLowerCase())
      if (!params.tokenOutDecimals && tokenOutObj) tokenOutDecimals = tokenOutObj.decimals;
      
      const amountOut = BigInt(result.amountOut)
      const priceImpact = result.priceImpact || '0.5' // 默认价格影响
      
      const indexPathUsed = Array.isArray(result.indexPathUsed)
        ? result.indexPathUsed
            .map((value: unknown) => Number(value))
            .filter((value: number) => Number.isFinite(value) && value >= 0)
        : undefined

      return {
        amountOut: formatUnits(amountOut, tokenOutDecimals),
        priceImpact,
        simulated: result.simulated || false,
        indexPathUsed,
      }
    } catch (error) {
      // 网络异常/后端异常等非业务错误，返回 null 防止 UI 抛错打断交互。
      console.error('Quote request failed:', error)
      return null
    }
  }, [getDefaultSqrtPriceLimit, isEthLikeToken])

  // 检查代币授权
  const useTokenAllowance = (tokenAddress: string) => {
    return useReadContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: address ? [address, contractConfig.swapRouter.address] : undefined,
      query: {
        enabled: Boolean(address && tokenAddress),
      },
    })
  }

  // 授权代币
  const approveToken = useCallback(async (tokenAddress: string, amount: string, decimals?: number) => {
    if (!address) return

    const token = Object.values(TOKENS).find(t => t.address === tokenAddress)
    const tokenDecimals = decimals ?? token?.decimals ?? 18
    const amountWei = parseUnits(amount, tokenDecimals)

    const gas = await estimateGasWithCap({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [contractConfig.swapRouter.address, amountWei],
      fallbackGas: APPROVE_GAS_FALLBACK,
    })

    writeContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [contractConfig.swapRouter.address, amountWei],
      gas,
    })
  }, [address, writeContract, estimateGasWithCap])

  // 执行交换
  const executeSwap = useCallback(async (params: SwapParams) => {
    if (!address || !publicClient) {
      throw new Error('Wallet not connected')
    }
    // NODEJS环境 window是 undefined

    const tokenIn = Object.values(TOKENS).find(t => t.address === params.tokenIn)
    const tokenOut = Object.values(TOKENS).find(t => t.address === params.tokenOut)

    const tokenInDecimals = params.tokenInDecimals ?? tokenIn?.decimals ?? 18
    const tokenOutDecimals = params.tokenOutDecimals ?? tokenOut?.decimals ?? 18

    const amountInWei = parseUnits(params.amountIn, tokenInDecimals)
    
    // 获取价格预估来计算最小输出
    const quote = await getQuote(params)
    if (!quote) {
      throw new Error('未找到交易对或无法获取报价')
    }

    // 检查是否是原生ETH交易
    const isNativeTokenIn = isEthLikeToken(params.tokenIn)
    
    // 如果是ETH交易，则使用wrappedAddress(WETH)
    const actualTokenIn = isNativeTokenIn
      ? TOKENS.ETH.wrappedAddress as string
      : params.tokenIn

    const actualTokenOut = isEthLikeToken(params.tokenOut)
      ? TOKENS.ETH.wrappedAddress as string
      : params.tokenOut

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200) // 20分钟后过期

    const resolvedRoute = await resolveAvailableRoute(actualTokenIn, actualTokenOut)
    if (resolvedRoute.indexPath.length === 0) {
      throw new Error('未找到可用池子')
    }

    // 注意：必须基于最终解析出的 tokenIn/tokenOut 方向计算价格边界，否则会触发 SPL。
    const sqrtPriceLimitX96 = getDefaultSqrtPriceLimit(
      resolvedRoute.tokenIn,
      resolvedRoute.tokenOut
    )

    let finalIndexPath = resolvedRoute.indexPath

    // 优先使用报价返回的 indexPathUsed，确保最终执行路径与后端选池一致。
    if (quote.indexPathUsed && quote.indexPathUsed.length > 0) {
      const quoteValidPath = quote.indexPathUsed.filter((index) => resolvedRoute.indexPath.includes(index))
      if (quoteValidPath.length > 0) {
        finalIndexPath = quoteValidPath
      } else {
        console.warn('Quote indexPathUsed is stale on-chain, fallback to available paths', {
          quoteIndexPathUsed: quote.indexPathUsed,
          availableIndexPath: resolvedRoute.indexPath,
        })
      }
    } else if (params.indexPath && params.indexPath.length > 0) {
      const validPath = params.indexPath.filter((index) => resolvedRoute.indexPath.includes(index))
      if (validPath.length > 0) {
        finalIndexPath = validPath
      }
    }

    // 执行前再做一次链上精准报价，减少与合约真实成交逻辑的偏差。
    let amountOutWei: bigint
    try {
      amountOutWei = await publicClient.readContract({
        address: contractConfig.swapRouter.address,
        abi: contractConfig.swapRouter.abi,
        functionName: 'quoteExactInput',
        args: [{
          tokenIn: resolvedRoute.tokenIn as `0x${string}`,
          tokenOut: resolvedRoute.tokenOut as `0x${string}`,
          indexPath: finalIndexPath,
          amountIn: amountInWei,
          sqrtPriceLimitX96,
        }],
      }) as bigint
    } catch (error) {
      console.warn('On-chain quoteExactInput failed, fallback to API quote result', error)
      amountOutWei = parseUnits(quote.amountOut, tokenOutDecimals)
    }

    if (amountOutWei <= 0n) {
      throw new Error('报价为 0，已阻止交易以避免只 wrapETH 不成交')
    }

    // 测试模式：关闭最小输出保护，避免因报价偏差触发 Slippage exceeded。
    const minAmountOut = 0n

    const swapParams = {
      tokenIn: resolvedRoute.tokenIn as `0x${string}`,
      tokenOut: resolvedRoute.tokenOut as `0x${string}`,
      indexPath: finalIndexPath,
      recipient: (isEthLikeToken(params.tokenOut)
        ? contractConfig.swapRouter.address
        : address) as `0x${string}`,
      deadline,
      amountIn: amountInWei,
      amountOutMinimum: minAmountOut,
      sqrtPriceLimitX96,
    }

    setLastSwapParams(params)

    const isNativeTokenOut = isEthLikeToken(params.tokenOut)

    const multicallData: `0x${string}`[] = []

    const shouldUsePermit =
      !isNativeTokenIn &&
      Boolean(params.tokenInSupportsPermit) &&
      Boolean(params.tokenInName)

    // 预检：非原生输入且不走 permit 时，先检查余额与授权，避免链上 TFF（transferFrom failed）。
    if (!isNativeTokenIn && !shouldUsePermit) {
      const [balance, allowance] = await Promise.all([
        publicClient.readContract({
          address: resolvedRoute.tokenIn as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        }),
        publicClient.readContract({
          address: resolvedRoute.tokenIn as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address, contractConfig.swapRouter.address],
        }),
      ])

      if (BigInt(balance) < amountInWei) {
        throw new Error('输入代币余额不足（会导致 transferFrom 失败）')
      }
      if (BigInt(allowance) < amountInWei) {
        throw new Error('授权不足，请先点击 Approve（会导致 transferFrom 失败）')
      }
    }

    if (shouldUsePermit) {
      const nonce = await publicClient.readContract({
        address: resolvedRoute.tokenIn as `0x${string}`,
        abi: ERC20_PERMIT_ABI,
        functionName: 'nonces',
        args: [address],
      })

      const signature = await signTypedDataAsync({
        account: address,
        domain: {
          name: params.tokenInName!,
          version: '1',
          chainId: publicClient.chain.id,
          verifyingContract: resolvedRoute.tokenIn as `0x${string}`,
        },
        types: {
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        message: {
          owner: address,
          spender: contractConfig.swapRouter.address,
          value: amountInWei,
          nonce,
          deadline,
        },
      })

      const parsed = parseSignature(signature)
      const permitV = Number(parsed.v ?? (parsed.yParity === 0 ? 27 : 28))
      const { r, s } = parsed

      multicallData.push(
        encodeFunctionData({
          abi: contractConfig.swapRouter.abi,
          functionName: 'selfPermitIfNecessary',
          args: [resolvedRoute.tokenIn as `0x${string}`, amountInWei, deadline, permitV, r, s],
        })
      )
    }

    if (isNativeTokenIn) {
      multicallData.push(
        encodeFunctionData({
          abi: contractConfig.swapRouter.abi,
          functionName: 'wrapETH',
          args: [],
        })
      )
    }

    multicallData.push(
      encodeFunctionData({
        abi: contractConfig.swapRouter.abi,
        functionName: 'exactInput',
        args: [swapParams],
      })
    )

    if (isNativeTokenOut || isNativeTokenIn) {
      multicallData.push(
        encodeFunctionData({
          abi: contractConfig.swapRouter.abi,
          functionName: 'unwrapWETH9',
          args: [0n, address as `0x${string}`],
        })
      )
    }

    const value = isNativeTokenIn ? amountInWei : 0n

    const gas = await estimateGasWithCap({
      address: contractConfig.swapRouter.address,
      abi: contractConfig.swapRouter.abi,
      functionName: 'multicall',
      args: [multicallData],
      value,
      fallbackGas: SWAP_GAS_FALLBACK,
    })

    writeContract({
      ...contractConfig.swapRouter,
      functionName: 'multicall',
      args: [multicallData],
      value,
      gas,
    })
  }, [address, writeContract, getQuote, publicClient, signTypedDataAsync, estimateGasWithCap, resolveAvailableRoute, getDefaultSqrtPriceLimit, isEthLikeToken])

  return {
    executeSwap,
    approveToken,
    getQuote,
    useTokenAllowance,
    isPending,
    isConfirming,
    isConfirmed,
    hash,
    lastSwapParams,
  }
} 