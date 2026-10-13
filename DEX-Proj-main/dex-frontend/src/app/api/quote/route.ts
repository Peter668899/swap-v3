import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

type PoolRow = {
  address: string
  pool_index: number
  fee: string | number
  liquidity: string
  token0: string
  token1: string
  sqrt_price_x96: string
}

const SCANNER_STALE_SECONDS = 180
const MIN_SQRT_PRICE = 4295128739n
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n
const ETH_SPECIAL_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const WETH_CANONICAL = (
  process.env.NEXT_PUBLIC_WETH9_ADDRESS ||
  process.env.NEXT_PUBLIC_WETH_ADDRESS ||
  process.env.WETH9_ADDRESS ||
  ''
).toLowerCase()
const WETH_ALIASES = new Set<string>([
  '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
])
if (WETH_CANONICAL) {
  WETH_ALIASES.add(WETH_CANONICAL)
}

function tokenAliases(token: string): string[] {
  const normalized = token.toLowerCase()
  if (normalized === ETH_SPECIAL_ADDRESS || WETH_ALIASES.has(normalized)) {
    return Array.from(WETH_ALIASES)
  }
  return [normalized]
}

function canonicalToken(token: string): string {
  const normalized = token.toLowerCase()
  if (normalized === ETH_SPECIAL_ADDRESS || WETH_ALIASES.has(normalized)) {
    return WETH_CANONICAL
  }
  return normalized
}

function getDefaultSqrtPriceLimit(tokenIn: string, tokenOut: string): bigint {
  const zeroForOne = canonicalToken(tokenIn) < canonicalToken(tokenOut)
  return zeroForOne ? (MIN_SQRT_PRICE + 1n) : (MAX_SQRT_PRICE - 1n)
}

async function findPoolsForPair(tokenIn: string, tokenOut: string) {
  const tokenInAliases = tokenAliases(tokenIn)
  const tokenOutAliases = tokenAliases(tokenOut)

  const clauses = new Set<string>()
  for (const a of tokenInAliases) {
    for (const b of tokenOutAliases) {
      clauses.add(`and(token0.ilike.${a},token1.ilike.${b})`)
      clauses.add(`and(token0.ilike.${b},token1.ilike.${a})`)
    }
  }

  const { data: pools, error } = await supabase
    .from('pools')
    .select('address, pool_index, fee, liquidity, token0, token1, sqrt_price_x96')
    .or(Array.from(clauses).join(','))
    .order('liquidity', { ascending: false })

  if (error) {
    console.error('Supabase pool query error:', error)
    return []
  }

  return (pools || []) as PoolRow[]
}

function normalizeIndexPath(indexPath: unknown): number[] {
  if (!Array.isArray(indexPath)) return []
  return indexPath
    .map((v: unknown) => Number(v))
    .filter((v: number) => Number.isFinite(v) && v >= 0)
}

async function isScannerStale(): Promise<boolean> {
  const { data, error } = await supabase
    .from('indexed_status')
    .select('updated_at')
    .eq('network', 'sepolia')
    .maybeSingle()

  if (error || !data?.updated_at) return false

  const updatedAt = Date.parse(data.updated_at)
  if (Number.isNaN(updatedAt)) return false

  const ageSeconds = (Date.now() - updatedAt) / 1000
  return ageSeconds > SCANNER_STALE_SECONDS
}

function simulateAmountOut(pool: PoolRow, tokenIn: string, amountIn: bigint): bigint {
  const liquidity = BigInt(pool.liquidity || '0')
  const currentSqrtPriceX96 = BigInt(pool.sqrt_price_x96 || '0')
  const feePips = BigInt(pool.fee || 0)
  if (liquidity === 0n || currentSqrtPriceX96 === 0n) return 0n

  const feeMultiplier = 1000000n - feePips
  const amountInAfterFee = (amountIn * feeMultiplier) / 1000000n
  const isToken0 = canonicalToken(tokenIn) === canonicalToken(pool.token0)
  const Q96 = 2n ** 96n

  const reserve0 = (liquidity * Q96) / currentSqrtPriceX96
  const reserve1 = (liquidity * currentSqrtPriceX96) / Q96
  if (reserve0 === 0n || reserve1 === 0n) return 0n

  return isToken0
    ? (reserve1 * amountInAfterFee) / (reserve0 + amountInAfterFee)
    : (reserve0 * amountInAfterFee) / (reserve1 + amountInAfterFee)
}

function isSqrtPriceLimitValid(
  pool: PoolRow,
  tokenIn: string,
  tokenOut: string,
  sqrtPriceLimitX96: bigint
): boolean {
  const current = BigInt(pool.sqrt_price_x96 || '0')
  if (current === 0n) return false

  const zeroForOne = canonicalToken(tokenIn) < canonicalToken(tokenOut)
  if (zeroForOne) {
    return sqrtPriceLimitX96 < current && sqrtPriceLimitX96 > MIN_SQRT_PRICE
  }
  return sqrtPriceLimitX96 > current && sqrtPriceLimitX96 < MAX_SQRT_PRICE
}

export async function POST(request: NextRequest) {
  try {
    if (!WETH_CANONICAL) {
      return NextResponse.json(
        { success: false, error: '缺少 WETH 地址配置（NEXT_PUBLIC_WETH9_ADDRESS / WETH9_ADDRESS）' },
        { status: 500 }
      )
    }

    const body = await request.json()
    const { tokenIn, tokenOut, amountIn, indexPath, sqrtPriceLimitX96 } = body

    if (!tokenIn || !tokenOut || !amountIn) {
      return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
    }

    // if (await isScannerStale()) {
    //   return NextResponse.json(
    //     { error: 'Indexer lagging', msg: '后端扫链未同步完成，请稍后重试' },
    //     { status: 503 }
    //   )
    // }

    const pools = await findPoolsForPair(tokenIn, tokenOut)
    if (!pools || pools.length === 0) {
      return NextResponse.json(
        { error: `No pool found for pair ${tokenIn}-${tokenOut}`, msg: '未找到交易对' },
        { status: 404 }
      )
    }

    const normalizedIndexes = normalizeIndexPath(indexPath)
    const requestedPools =
      normalizedIndexes.length > 0
        ? pools.filter((p) => normalizedIndexes.includes(Number(p.pool_index)))
        : pools
    const amountInBigInt = BigInt(amountIn)
    const sqrtLimit = sqrtPriceLimitX96
      ? BigInt(sqrtPriceLimitX96)
      : getDefaultSqrtPriceLimit(tokenIn, tokenOut)

    // 纯数据库近似报价：在候选池中选出可成交 amountOut 最大的一条路径，避免仅按流动性排序导致误选。
    const candidatePools = requestedPools.length > 0 ? requestedPools : pools
    const bestCandidate = candidatePools
      .map((pool) => ({
        pool,
        amountOut: isSqrtPriceLimitValid(pool, tokenIn, tokenOut, sqrtLimit)
          ? simulateAmountOut(pool, tokenIn, amountInBigInt)
          : 0n,
      }))
      .reduce<{ pool: PoolRow; amountOut: bigint } | null>((best, current) => {
        if (current.amountOut <= 0n) return best
        if (!best || current.amountOut > best.amountOut) return current
        return best
      }, null)

    if (!bestCandidate) {
      return NextResponse.json({ error: 'Pool has no liquidity', msg: '池子没有足够的流动性' }, { status: 400 })
    }
    const pool = bestCandidate.pool
    const calcAmountOut = bestCandidate.amountOut
    const indexPathUsed = [Number(pool.pool_index ?? 0)]

    return NextResponse.json({
      amountOut: calcAmountOut.toString(),
      poolAddress: pool.address,
      poolIndex: Number(pool.pool_index ?? 0),
      indexPathUsed,
      success: true,
      simulated: true,
    })

  } catch (error) {
    console.error('API Error:', error)
    return NextResponse.json({ error: 'Internal Server Error', msg: '内部服务器错误' }, { status: 500 })
  }
}
