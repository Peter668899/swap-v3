'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { supabase } from '@/lib/supabase'

export interface PositionInfo {
  id: string
  owner: string
  token0: string
  token1: string
  index: number
  fee: number
  liquidity: string
  tickLower: number
  tickUpper: number
  tokensOwed0: string
  tokensOwed1: string
  feeGrowthInside0LastX128: string
  feeGrowthInside1LastX128: string
  // 计算得出的字段
  token0Symbol: string
  token1Symbol: string
  token0Name: string
  token1Name: string
  pair: string
  feePercent: string
  liquidityValue: string
  totalFeesValue: string
  status: 'in-range' | 'out-of-range'
  priceRange: string
}

interface SupabasePositionRow {
  id: string | number
  owner: string
  pool_address: string
  token0: string
  token1: string
  tick_lower: number
  tick_upper: number
  liquidity: string
  tokens_owed0: string
  tokens_owed1: string
  fee_growth_inside0_last_x128: string
  fee_growth_inside1_last_x128: string
  token0_data?: {
    symbol?: string
    name?: string
    decimals?: number
  } | null
  token1_data?: {
    symbol?: string
    name?: string
    decimals?: number
  } | null
  pool_data?: {
    fee?: number
    tick?: number
  } | null
}

// Tick 转价格的简化计算（实际项目中需要使用精确的数学库）
const tickToPrice = (tick: number): number => {
  return Math.pow(1.0001, tick)
}

export const usePositions = () => {
  const { address, isConnected } = useAccount()
  const [positions, setPositions] = useState<PositionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadPositions = useCallback(async () => {
    if (!isConnected || !address) {
      setPositions([])
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)

    try {
      const { data, error: queryError } = await supabase
        .from('positions')
        .select(`
          id,
          owner,
          pool_address,
          token0,
          token1,
          tick_lower,
          tick_upper,
          liquidity,
          tokens_owed0,
          tokens_owed1,
          fee_growth_inside0_last_x128,
          fee_growth_inside1_last_x128,
          token0_data:tokens!token0(symbol, name, decimals),
          token1_data:tokens!token1(symbol, name, decimals),
          pool_data:pools!pool_address(fee, tick)
        `)
        .filter('owner', 'ilike', address)
        .order('updated_at', { ascending: false })

      if (queryError) {
        throw queryError
      }

      const processedPositions = ((data || []) as SupabasePositionRow[]).map((position) => {
        const token0Info = position.token0_data || { symbol: 'UNK', name: 'Unknown Token', decimals: 18 }
        const token1Info = position.token1_data || { symbol: 'UNK', name: 'Unknown Token', decimals: 18 }

        const liquidity = position.liquidity?.toString?.() || '0'
        const tokensOwed0 = position.tokens_owed0?.toString?.() || '0'
        const tokensOwed1 = position.tokens_owed1?.toString?.() || '0'

        const fee = Number(position.pool_data?.fee || 0)
        const feePercent = fee ? `${(fee / 10000).toFixed(2)}%` : '--'

        const priceLower = tickToPrice(position.tick_lower)
        const priceUpper = tickToPrice(position.tick_upper)
        const priceRange = `${priceLower.toFixed(4)} - ${priceUpper.toFixed(4)}`

        const currentTick = Number(position.pool_data?.tick ?? position.tick_lower - 1)
        const status: 'in-range' | 'out-of-range' =
          currentTick >= position.tick_lower && currentTick <= position.tick_upper && Number(liquidity) > 0
            ? 'in-range'
            : 'out-of-range'

        const liquidityNum = Number(liquidity)
        const liquidityValue = liquidityNum >= 1000
          ? `$${(liquidityNum / 1000).toFixed(2)}K`
          : `$${liquidityNum.toFixed(2)}`

        const totalFeesNum = Number(tokensOwed0) + Number(tokensOwed1)
        const totalFeesValue = `$${totalFeesNum.toFixed(2)}`

        return {
          id: String(position.id),
          owner: position.owner,
          token0: position.token0,
          token1: position.token1,
          index: 0,
          fee,
          liquidity,
          tickLower: position.tick_lower,
          tickUpper: position.tick_upper,
          tokensOwed0,
          tokensOwed1,
          feeGrowthInside0LastX128: position.fee_growth_inside0_last_x128?.toString?.() || '0',
          feeGrowthInside1LastX128: position.fee_growth_inside1_last_x128?.toString?.() || '0',
          token0Symbol: token0Info.symbol || 'UNK',
          token1Symbol: token1Info.symbol || 'UNK',
          token0Name: token0Info.name || 'Unknown Token',
          token1Name: token1Info.name || 'Unknown Token',
          pair: `${token0Info.symbol || 'UNK'}/${token1Info.symbol || 'UNK'}`,
          feePercent,
          liquidityValue,
          totalFeesValue,
          status,
          priceRange,
        }
      })

      setPositions(processedPositions)
      setError(null)
    } catch (err) {
      console.error('获取头寸数据出错:', err)
      setPositions([])
      setError(err instanceof Error ? err.message : '获取头寸数据失败')
    } finally {
      setLoading(false)
    }
  }, [address, isConnected])

  useEffect(() => {
    loadPositions()
  }, [loadPositions])

  // 计算统计数据
  const stats = {
    activePositions: positions.filter(p => p.status === 'in-range').length,
    totalValue: positions.reduce((sum, position) => {
      const value = parseFloat(position.liquidityValue.replace(/[$,K]/g, ''))
      return sum + (position.liquidityValue.includes('K') ? value * 1000 : value)
    }, 0),
    totalUnclaimedFees: positions.reduce((sum, position) => {
      const fees = parseFloat(position.totalFeesValue.replace(/[$,]/g, ''))
      return sum + fees
    }, 0),
    totalReturn: 0, // 简化版本，实际需要复杂计算
  }

  return {
    positions,
    loading,
    error,
    stats,
    refetch: loadPositions,
  }
} 