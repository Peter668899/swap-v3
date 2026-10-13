'use client'

import { useEffect, useMemo } from 'react'
import { useReadContract, useAccount } from 'wagmi'
import { formatUnits } from 'viem'
import { contractConfig } from '@/lib/contracts'
import { TOKENS } from '@/lib/constants'
// import { useMultiplePoolsData } from './usePoolData'

export interface PoolInfo {
  pool: string
  token0: string
  token1: string
  index: number
  fee: number
  liquidity: string
  sqrtPriceX96: string
  tick: number
  token0Symbol: string
  token1Symbol: string
  token0Name: string
  token1Name: string
  tvl: string
  volume24h: string
  pair: string
  feePercent: string
  token0Balance: string
  token1Balance: string
  tvlUSD: number
  volumeUSD: number
  feesUSD: number
}

interface RawPoolData {
  pool: string
  token0: string
  token1: string
  index: number | bigint
  fee: number
  liquidity: string | bigint
  sqrtPriceX96: string | bigint
  tick: number
}

/** 仅随链上池子实质内容变化而变，避免 wagmi 每次返回新引用时触发无限 setState。 */
function poolsDataChainKey(poolsData: unknown): string {
  if (!poolsData || !Array.isArray(poolsData)) return ''
  return JSON.stringify(
    (poolsData as RawPoolData[]).map((p) => {
      const liq = (typeof p.liquidity === 'bigint' ? p.liquidity : BigInt(String(p.liquidity ?? 0))).toString()
      const sqrt = typeof p.sqrtPriceX96 === 'bigint' ? p.sqrtPriceX96.toString() : String(p.sqrtPriceX96 ?? '0')
      return [
        String(p.pool).toLowerCase(),
        p.token0.toLowerCase(),
        p.token1.toLowerCase(),
        Number(p.index),
        p.fee,
        liq,
        sqrt,
        p.tick,
      ]
    })
  )
}

export const usePools = () => {
  const { isConnected } = useAccount()

  // 获取所有池子
  const { data: poolsData, isLoading: poolsLoading, error: poolsError } = useReadContract({
    ...contractConfig.poolManager,
    functionName: 'getAllPools',
    query: {
      enabled: isConnected,
    },
  })

  const poolsChainKey = useMemo(() => poolsDataChainKey(poolsData), [poolsData])

  const { pools, mapError } = useMemo(() => {
    if (!poolsData || !Array.isArray(poolsData)) {
      return { pools: [] as PoolInfo[], mapError: null as string | null }
    }
    try {
      const processedPools = (poolsData as RawPoolData[]).map((pool) => {
        const getTokenInfo = (address: string) => {
          const token = Object.values(TOKENS).find((t) => t.address.toLowerCase() === address.toLowerCase())
          return token || { symbol: 'UNKNOWN', name: 'Unknown Token' }
        }

        const token0Info = getTokenInfo(pool.token0)
        const token1Info = getTokenInfo(pool.token1)

        const liquidity = formatUnits(BigInt(pool.liquidity || '0'), 18)
        const feePercent = (pool.fee / 10000).toFixed(2) + '%'

        const tvl = '$0'
        const volume24h = '$0'
        const token0Balance = '0'
        const token1Balance = '0'
        const tvlUSD = 0
        const volumeUSD = 0
        const feesUSD = 0

        return {
          pool: pool.pool,
          token0: pool.token0,
          token1: pool.token1,
          index: Number(pool.index),
          fee: pool.fee,
          liquidity,
          sqrtPriceX96: pool.sqrtPriceX96?.toString() || '0',
          tick: pool.tick,
          token0Symbol: token0Info.symbol,
          token1Symbol: token1Info.symbol,
          token0Name: token0Info.name,
          token1Name: token1Info.name,
          tvl,
          volume24h,
          pair: `${token0Info.symbol}/${token1Info.symbol}`,
          feePercent,
          token0Balance,
          token1Balance,
          tvlUSD,
          volumeUSD,
          feesUSD,
        }
      })

      return { pools: processedPools, mapError: null }
    } catch (err) {
      console.error('处理池子数据时出错:', err)
      return { pools: [] as PoolInfo[], mapError: '处理池子数据失败' }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poolsChainKey 已序列化 poolsData 内容；避免 unstable 引用导致死循环
  }, [poolsChainKey])

  useEffect(() => {
    if (poolsError) {
      console.error('获取池子数据出错:', poolsError)
    }
  }, [poolsError])

  const error =
    poolsError != null ? '获取池子数据失败' : mapError
  const loading = Boolean(isConnected && poolsLoading)

  // 计算总计数据
  const totalStats = {
    totalPools: pools.length,
    totalTVL: pools.reduce((sum, pool) => sum + pool.tvlUSD, 0),
    totalVolume24h: pools.reduce((sum, pool) => sum + pool.volumeUSD, 0),
    totalFeesGenerated: pools.reduce((sum, pool) => sum + pool.feesUSD, 0),
  }

  return {
    pools,
    loading,
    error,
    totalStats,
    refetch: () => {
      // 重新拉取由 wagmi / tanstack query 管理；如需强制刷新可在此接入 queryClient.invalidateQueries
    },
  }
} 