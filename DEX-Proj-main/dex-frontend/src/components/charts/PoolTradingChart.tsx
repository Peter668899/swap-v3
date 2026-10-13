'use client'

import { useEffect, useMemo, useRef } from 'react'
import {
  createChart,
  AreaSeries,
  HistogramSeries,
  ColorType,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts'

type SwapPoint = {
  sqrt_price_x96: string
  amount0: string
  amount1: string
  block_timestamp: string
}

type PoolTradingChartProps = {
  swaps: SwapPoint[]
  token0Symbol: string
  token1Symbol: string
  token0Decimals: number
  token1Decimals: number
}

type PricePoint = {
  time: UTCTimestamp
  value: number
}

type VolumePoint = {
  time: UTCTimestamp
  value: number
  color: string
}

const Q96 = 2n ** 96n

function sqrtPriceX96ToPrice(
  sqrtPriceX96: string,
  token0Decimals: number,
  token1Decimals: number,
): number {
  const sqrt = Number(BigInt(sqrtPriceX96)) / Number(Q96)
  const ratio = sqrt * sqrt
  const decimalAdjust = 10 ** (token0Decimals - token1Decimals)
  return ratio * decimalAdjust
}

export default function PoolTradingChart({
  swaps,
  token0Symbol,
  token1Symbol,
  token0Decimals,
  token1Decimals,
}: PoolTradingChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)

  const chartData = useMemo(() => {
    const sortedSwaps = [...swaps].sort(
      (a, b) => new Date(a.block_timestamp).getTime() - new Date(b.block_timestamp).getTime(),
    )

    const priceData: PricePoint[] = []
    const volumeData: VolumePoint[] = []

    for (const swap of sortedSwaps) {
      const timestamp = Math.floor(new Date(swap.block_timestamp).getTime() / 1000) as UTCTimestamp
      const price = sqrtPriceX96ToPrice(swap.sqrt_price_x96, token0Decimals, token1Decimals)
      const amount0 = Math.abs(Number(swap.amount0)) / 10 ** token0Decimals
      const amount1 = Math.abs(Number(swap.amount1)) / 10 ** token1Decimals
      const volumeInToken1 = amount1 > 0 ? amount1 : amount0 * price

      if (!Number.isFinite(price) || price <= 0) continue

      priceData.push({
        time: timestamp,
        value: price,
      })

      volumeData.push({
        time: timestamp,
        value: Number.isFinite(volumeInToken1) ? volumeInToken1 : 0,
        color: Number(swap.amount0) < 0 ? 'rgba(34, 197, 94, 0.45)' : 'rgba(239, 68, 68, 0.45)',
      })
    }

    return { priceData, volumeData }
  }, [swaps, token0Decimals, token1Decimals])

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#475569',
      },
      grid: {
        vertLines: { color: '#f1f5f9' },
        horzLines: { color: '#f1f5f9' },
      },
      crosshair: {
        vertLine: { color: '#94a3b8', labelBackgroundColor: '#2563eb' },
        horzLine: { color: '#94a3b8', labelBackgroundColor: '#2563eb' },
      },
      rightPriceScale: {
        borderColor: '#e2e8f0',
      },
      timeScale: {
        borderColor: '#e2e8f0',
        timeVisible: true,
        secondsVisible: false,
      },
      localization: {
        priceFormatter: (value: number) => value.toFixed(6),
      },
    })

    chartRef.current = chart

    const areaSeries = chart.addSeries(AreaSeries, {
      lineColor: '#2563eb',
      topColor: 'rgba(37, 99, 235, 0.24)',
      bottomColor: 'rgba(37, 99, 235, 0.02)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    })

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '',
    })

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    })

    areaSeries.setData(chartData.priceData)
    volumeSeries.setData(chartData.volumeData)
    chart.timeScale().fitContent()

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry || !chartRef.current) return
      chartRef.current.applyOptions({
        width: entry.contentRect.width,
      })
    })

    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [chartData])

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-bold text-gray-900">Price & Volume</h3>
          <p className="text-sm text-gray-500">
            {token1Symbol} per {token0Symbol} with swap volume overlay
          </p>
        </div>
      </div>

      {chartData.priceData.length === 0 ? (
        <div className="h-[360px] flex items-center justify-center text-sm text-gray-500 bg-gray-50 rounded-lg">
          暂无足够的历史成交数据用于绘图
        </div>
      ) : (
        <div ref={containerRef} className="h-[360px] w-full" />
      )}
    </div>
  )
}
