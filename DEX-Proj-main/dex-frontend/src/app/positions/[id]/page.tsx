'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { ArrowLeft, Loader2, TrendingDown, TrendingUp, Plus, Minus, Coins, X, Settings, Check } from 'lucide-react'
import { NetworkChecker } from '@/components/NetworkChecker'
import { usePositions } from '@/hooks/usePositions'
import { formatNumber } from '@/lib/utils'

export default function PositionDetailPage() {
  const params = useParams<{ id: string }>()
  const positionId = params?.id
  const { isConnected } = useAccount()
  const { positions, loading, error, refetch } = usePositions()
  const [activeModal, setActiveModal] = useState<'add' | 'remove' | null>(null)
  const [selectedPercent, setSelectedPercent] = useState(0)
  const [asEth, setAsEth] = useState(true)
  const [inputAmount, setInputAmount] = useState('')

  const position = positions.find((item) => item.id === positionId)
  const quickPercents = [25, 50, 75, 100]

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <NetworkChecker>
        <div className="mb-6">
          <Link
            href="/positions"
            className="inline-flex items-center text-gray-500 hover:text-gray-700 mb-4 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回头寸列表
          </Link>
        </div>

        {!isConnected ? (
          <div className="bg-white border rounded-xl p-12 text-center">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">请先连接钱包</h3>
            <p className="text-gray-600">连接钱包后可查看头寸详情</p>
          </div>
        ) : loading ? (
          <div className="bg-white border rounded-xl p-12 text-center">
            <Loader2 className="h-8 w-8 text-blue-600 mx-auto mb-4 animate-spin" />
            <p className="text-gray-600">正在加载头寸详情...</p>
          </div>
        ) : error ? (
          <div className="bg-white border rounded-xl p-12 text-center">
            <p className="text-red-600 font-medium mb-3">{error}</p>
            <button
              onClick={refetch}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg"
            >
              重新加载
            </button>
          </div>
        ) : !position ? (
          <div className="bg-white border rounded-xl p-12 text-center">
            <p className="text-gray-700 font-medium mb-2">未找到该头寸</p>
            <p className="text-gray-500 text-sm">ID: {positionId}</p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="bg-white border rounded-xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-bold text-gray-900 mb-2">
                    {position.pair}
                    <span className="ml-2 text-sm px-2 py-1 bg-gray-100 rounded">
                      {position.feePercent}
                    </span>
                  </h1>
                  <div className="text-sm text-gray-500">头寸 ID: #{position.id}</div>
                </div>
                <span className={`px-2 py-1 rounded text-xs font-medium inline-flex items-center gap-1 ${
                  position.status === 'in-range'
                    ? 'bg-green-100 text-green-800'
                    : 'bg-red-100 text-red-800'
                }`}>
                  {position.status === 'in-range' ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {position.status === 'in-range' ? '范围内' : '范围外'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white border rounded-xl p-5">
                <div className="text-sm text-gray-500 mb-1">流动性估值</div>
                <div className="text-xl font-semibold">{position.liquidityValue}</div>
                <div className="text-xs text-gray-500 mt-1">
                  {formatNumber(parseFloat(position.liquidity))} LP
                </div>
              </div>
              <div className="bg-white border rounded-xl p-5">
                <div className="text-sm text-gray-500 mb-1">未领取费用</div>
                <div className="text-xl font-semibold text-green-600">{position.totalFeesValue}</div>
                <div className="text-xs text-gray-500 mt-1">
                  {parseFloat(position.tokensOwed0).toFixed(4)} {position.token0Symbol} + {parseFloat(position.tokensOwed1).toFixed(4)} {position.token1Symbol}
                </div>
              </div>
              <div className="bg-white border rounded-xl p-5">
                <div className="text-sm text-gray-500 mb-1">价格范围</div>
                <div className="text-base font-semibold break-all">{position.priceRange}</div>
              </div>
              <div className="bg-white border rounded-xl p-5">
                <div className="text-sm text-gray-500 mb-1">Tick 范围</div>
                <div className="text-base font-semibold">{position.tickLower} ~ {position.tickUpper}</div>
              </div>
            </div>

            <div className="bg-white border rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">操作</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Link
                  href={`/liquidity?positionId=${position.id}&action=add`}
                  className="inline-flex justify-center items-center gap-2 rounded-lg border border-blue-200 text-blue-700 hover:bg-blue-50 px-4 py-3"
                >
                  <Plus className="h-4 w-4" />
                  增加流动性
                </Link>
                <Link
                  href={`/liquidity?positionId=${position.id}&action=remove`}
                  className="inline-flex justify-center items-center gap-2 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 px-4 py-3"
                >
                  <Minus className="h-4 w-4" />
                  移除流动性
                </Link>
                <Link
                  href={`/liquidity?positionId=${position.id}&action=collect`}
                  className="inline-flex justify-center items-center gap-2 rounded-lg border border-green-200 text-green-700 hover:bg-green-50 px-4 py-3"
                >
                  <Coins className="h-4 w-4" />
                  领取费用
                </Link>
              </div>
            </div>
            <div className="bg-white border rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">快捷弹窗</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <button
                  onClick={() => {
                    setSelectedPercent(0)
                    setInputAmount('')
                    setActiveModal('add')
                  }}
                  className="inline-flex justify-center items-center gap-2 rounded-lg border border-blue-200 text-blue-700 hover:bg-blue-50 px-4 py-3"
                >
                  <Plus className="h-4 w-4" />
                  添加流动性（弹窗）
                </button>
                <button
                  onClick={() => {
                    setSelectedPercent(0)
                    setActiveModal('remove')
                  }}
                  className="inline-flex justify-center items-center gap-2 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 px-4 py-3"
                >
                  <Minus className="h-4 w-4" />
                  移除流动性（弹窗）
                </button>
              </div>
            </div>
          </div>
        )}
      </NetworkChecker>

      {position && activeModal && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] flex items-center justify-center p-4"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="w-full max-w-3xl rounded-3xl bg-white p-6 md:p-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <button
                className="text-gray-500 hover:text-gray-700"
                onClick={() => setActiveModal(null)}
              >
                <X className="h-8 w-8" />
              </button>
              <h3 className="text-4xl font-extrabold tracking-tight">
                {activeModal === 'add' ? '添加流动性' : '移除流动性'}
              </h3>
              <button className="text-gray-500 hover:text-gray-700">
                <Settings className="h-7 w-7" />
              </button>
            </div>

            <div className="mb-6">
              <div className="text-5xl font-black">
                {position.token0Symbol} / {position.token1Symbol}
              </div>
              <div className="mt-2 inline-flex items-center gap-2 text-emerald-600 text-3xl font-bold">
                <span className="h-3 w-3 rounded-full bg-emerald-500" />
                在区间内
              </div>
            </div>

            <div className="rounded-3xl border bg-gray-50 p-5 mb-4">
              {activeModal === 'add' ? (
                <>
                  <div className="text-8xl font-extrabold text-gray-400 mb-4">
                    <input
                      value={inputAmount}
                      onChange={(e) => setInputAmount(e.target.value)}
                      placeholder="0"
                      className="w-full bg-transparent outline-none text-8xl font-extrabold text-gray-400 placeholder:text-gray-300"
                    />
                  </div>
                  <div className="text-right text-3xl font-semibold">{position.token0Symbol}</div>
                </>
              ) : (
                <>
                  <div className="text-2xl font-semibold mb-3">提取金额</div>
                  <div className="text-center text-8xl font-extrabold text-gray-400 mb-2">{selectedPercent}%</div>
                </>
              )}

              <div className="mt-5 flex flex-wrap gap-3">
                {quickPercents.map((percent) => (
                  <button
                    key={percent}
                    onClick={() => setSelectedPercent(percent)}
                    className={`px-6 py-2 rounded-full border text-2xl font-bold ${
                      selectedPercent === percent
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-800 border-gray-200 hover:bg-gray-100'
                    }`}
                  >
                    {percent === 100 ? '最高' : `${percent}%`}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-gray-50 border p-4 mb-6 flex items-center justify-between">
              <span className="text-4xl font-extrabold text-gray-700">
                {activeModal === 'add' ? '作为 ETH 添加' : '作为 ETH 提取'}
              </span>
              <button
                onClick={() => setAsEth((prev) => !prev)}
                className={`w-28 h-14 rounded-full p-1 transition-colors ${asEth ? 'bg-fuchsia-500' : 'bg-gray-300'}`}
              >
                <span className={`h-12 w-12 rounded-full bg-white flex items-center justify-center transition-transform ${asEth ? 'translate-x-14' : 'translate-x-0'}`}>
                  <Check className="h-6 w-6 text-fuchsia-500" />
                </span>
              </button>
            </div>

            <div className="mb-6 text-4xl font-bold leading-relaxed">
              <div>{position.token0Symbol} 头寸 <span className="float-right">&lt;0.001 {position.token0Symbol}</span></div>
              <div>{position.token1Symbol} 头寸 <span className="float-right">0.100 {position.token1Symbol}</span></div>
            </div>

            <button
              className="w-full rounded-2xl bg-gray-100 hover:bg-gray-200 py-5 text-5xl font-black text-gray-600"
              onClick={() => setActiveModal(null)}
            >
              {activeModal === 'add' ? '输入金额' : '审查'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

