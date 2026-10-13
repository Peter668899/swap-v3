'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAccount, useBalance, useWriteContract, useWaitForTransactionReceipt, useReadContracts, usePublicClient, useSignTypedData } from 'wagmi'
import { BaseError, parseUnits, formatUnits, encodeFunctionData, parseSignature } from 'viem'
import { ChevronDown, Clock, CheckCircle, AlertCircle, ArrowUpDown, Info } from 'lucide-react'
import { TOKENS, CONTRACTS, FEE_TIERS, getTokenByAddress, isNativeTokenAddress, toChainTokenAddress } from '@/lib/constants'
import { cn, formatTokenAmount, parseInputAmount, shortenAddress } from '@/lib/utils'
import { ERC20_ABI, contractConfig } from '@/lib/contracts'

type Token = {
  address: string
  symbol: string
  name: string
  decimals: number
}

type Step = 'select' | 'searching' | 'found' | 'notFound' | 'addLiquidity'
type TransactionAction = 'wrap0' | 'wrap1' | 'approve0' | 'approve1' | 'createPool' | 'addLiquidity'
type ContractWriteParams = {
  address: `0x${string}`
  abi: readonly unknown[]
  functionName: string
  args: readonly unknown[] | [unknown]
  value?: bigint
}

const GAS_LIMIT_CAP = 16_000_000n
const SELF_PERMIT_IF_NECESSARY_SELECTOR = '0xc2e3140a'
// 稳定性优先：流动性路径固定只走 approve，不走 permit 子调用
const ENABLE_PERMIT_LIQUIDITY = false
const WETH_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const

const ERC20_PERMIT_ABI = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'DOMAIN_SEPARATOR',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

const EIP712_VERSION_ABI = [
  {
    type: 'function',
    name: 'version',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const

export default function LiquidityManager() {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const searchParams = useSearchParams()

  const resolveKnownToken = useCallback((tokenAddress: string): Token | null => {
    const known = getTokenByAddress(tokenAddress)
    if (!known) return null

    const isWrappedEth = 'wrappedAddress' in known &&
      typeof known.wrappedAddress === 'string' &&
      known.wrappedAddress.toLowerCase() === tokenAddress.toLowerCase() &&
      known.address.toLowerCase() !== tokenAddress.toLowerCase()

    if (isWrappedEth) {
      return {
        address: tokenAddress,
        symbol: 'WETH',
        name: 'Wrapped Ethereum',
        decimals: known.decimals,
      }
    }

    return {
      address: tokenAddress,
      symbol: known.symbol,
      name: known.name,
      decimals: known.decimals,
    }
  }, [])

  const getRequiredBalanceLabel = useCallback((token: Token | null) => {
    if (!token) return '代币'
    if (isNativeTokenAddress(token.address)) {
      return 'WETH'
    }
    return token.symbol
  }, [])
  
  // 步骤状态
  const [step, setStep] = useState<Step>('select')
  
  // 选择参数
  const [selectedToken0Address, setSelectedToken0Address] = useState('')
  const [selectedToken1Address, setSelectedToken1Address] = useState('')
  const [selectedFee, setSelectedFee] = useState(3000)
  const [selectedChainId, setSelectedChainId] = useState(11155111) // Sepolia
  
  // 代币信息（从链上获取或已知代币）
  const [token0, setToken0] = useState<Token | null>(null)
  const [token1, setToken1] = useState<Token | null>(null)
  
  const [amount0, setAmount0] = useState('')
  const [amount1, setAmount1] = useState('')
  const [initialPrice, setInitialPrice] = useState('1') // 初始价格比率（token0:token1）
  
  const [needsApproval0, setNeedsApproval0] = useState(false)
  const [needsApproval1, setNeedsApproval1] = useState(false)
  const [isCalculating, setIsCalculating] = useState(false)
  const [poolExists, setPoolExists] = useState(false)
  const [currentPool, setCurrentPool] = useState<string | null>(null)
  const [poolIndex, setPoolIndex] = useState<number | null>(null)
  const [isCheckingPool, setIsCheckingPool] = useState(false)
  const [isCheckingAllowance, setIsCheckingAllowance] = useState(false)
  const [priceError, setPriceError] = useState<string | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [transactionAction, setTransactionAction] = useState<TransactionAction | null>(null)
  const [transactionError, setTransactionError] = useState<string | null>(null)
  const [permitSupportMap, setPermitSupportMap] = useState<Record<string, boolean>>({})

  // 合约交互
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContract, data: hash, isPending } = useWriteContract()
  const isSelfPermitIfNecessaryCalldata = useCallback((calldata: `0x${string}`) => {
    return calldata.slice(0, 10).toLowerCase() === SELF_PERMIT_IF_NECESSARY_SELECTOR
  }, [])
  const getErrorMessage = useCallback((error: unknown) => {
    if (error instanceof BaseError) {
      return error.shortMessage || error.message
    }

    if (error instanceof Error) {
      return error.message
    }

    return '交易提交失败'
  }, [])

  const writeContractWithEstimatedGas = useCallback(async ({
    address: contractAddress,
    abi,
    functionName,
    args,
    value,
  }: ContractWriteParams) => {
    if (!address) {
      throw new Error('钱包未连接')
    }

    if (!publicClient) {
      throw new Error('公共客户端未初始化')
    }

    const estimatedGas = await publicClient.estimateContractGas({
      account: address,
      address: contractAddress,
      abi,
      functionName,
      args,
      value,
    } as never)

    const gas = estimatedGas * 12n / 10n

    writeContract({
      account: address,
      address: contractAddress,
      abi,
      functionName,
      args,
      value,
      gas: gas > GAS_LIMIT_CAP ? GAS_LIMIT_CAP : gas,
    } as never)
  }, [address, publicClient, writeContract])

  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash,
  })

  const writeMetaNodeManagerMulticall = useCallback(async (calldatas: `0x${string}`[]) => {
    try {
      await writeContractWithEstimatedGas({
        address: CONTRACTS.META_NODE_MANAGER as `0x${string}`,
        abi: contractConfig.metaNodeManager.abi,
        functionName: 'multicall',
        args: [calldatas],
      })
      return
    } catch (error) {
      // permit 失败时尝试降级为不带 permit 的 multicall，避免整包失败
      const hasPermitCall = calldatas.some(isSelfPermitIfNecessaryCalldata)
      if (!hasPermitCall) throw error

      const fallbackCalldatas = calldatas.filter((data) => !isSelfPermitIfNecessaryCalldata(data))
      if (fallbackCalldatas.length === 0) throw error

      console.warn('Permit multicall 失败，回退为不带 permit 的调用重试')
      await writeContractWithEstimatedGas({
        address: CONTRACTS.META_NODE_MANAGER as `0x${string}`,
        abi: contractConfig.metaNodeManager.abi,
        functionName: 'multicall',
        args: [fallbackCalldatas],
      })
    }
  }, [isSelfPermitIfNecessaryCalldata, writeContractWithEstimatedGas])

  // 处理 URL 参数（用于预填充）
  const paramToken0 = searchParams.get('token0') as `0x${string}`
  const paramToken1 = searchParams.get('token1') as `0x${string}`

  useEffect(() => {
    if (paramToken0) {
      setSelectedToken0Address(paramToken0)
    }
    if (paramToken1) {
      setSelectedToken1Address(paramToken1)
    }
  }, [paramToken0, paramToken1])

  // 获取代币信息
  const { data: token0Data } = useReadContracts({
    contracts: selectedToken0Address && !isNativeTokenAddress(selectedToken0Address) ? [
      { address: selectedToken0Address as `0x${string}`, abi: ERC20_ABI, functionName: 'symbol' as const },
      { address: selectedToken0Address as `0x${string}`, abi: ERC20_ABI, functionName: 'name' as const },
      { address: selectedToken0Address as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' as const },
    ] : [],
    query: { enabled: !!selectedToken0Address && !isNativeTokenAddress(selectedToken0Address) }
  })

  const { data: token1Data } = useReadContracts({
    contracts: selectedToken1Address && !isNativeTokenAddress(selectedToken1Address) ? [
      { address: selectedToken1Address as `0x${string}`, abi: ERC20_ABI, functionName: 'symbol' as const },
      { address: selectedToken1Address as `0x${string}`, abi: ERC20_ABI, functionName: 'name' as const },
      { address: selectedToken1Address as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' as const },
    ] : [],
    query: { enabled: !!selectedToken1Address && !isNativeTokenAddress(selectedToken1Address) }
  })

  useEffect(() => {
    if (selectedToken0Address && token0Data) {
      const [symbol, name, decimals] = token0Data
      if (symbol?.status === 'success' && name?.status === 'success' && decimals?.status === 'success') {
        setToken0({
          address: selectedToken0Address,
          symbol: String(symbol.result || ''),
          name: String(name.result || ''),
          decimals: Number(decimals.result || 18),
        })
      } else {
        const known = resolveKnownToken(selectedToken0Address)
        if (known) setToken0(known)
      }
    } else if (selectedToken0Address && isNativeTokenAddress(selectedToken0Address)) {
      const known = resolveKnownToken(selectedToken0Address)
      if (known) setToken0(known)
    }
  }, [selectedToken0Address, token0Data, resolveKnownToken])

  useEffect(() => {
    if (selectedToken1Address && token1Data) {
      const [symbol, name, decimals] = token1Data
      if (symbol?.status === 'success' && name?.status === 'success' && decimals?.status === 'success') {
        setToken1({
          address: selectedToken1Address,
          symbol: String(symbol.result || ''),
          name: String(name.result || ''),
          decimals: Number(decimals.result || 18),
        })
      } else {
        const known = resolveKnownToken(selectedToken1Address)
        if (known) setToken1(known)
      }
    } else if (selectedToken1Address && isNativeTokenAddress(selectedToken1Address)) {
      const known = resolveKnownToken(selectedToken1Address)
      if (known) setToken1(known)
    }
  }, [selectedToken1Address, token1Data, resolveKnownToken])

  const detectPermitSupport = useCallback(async (tokenAddress: string) => {
    if (!publicClient) return false
    try {
      const owner = (address ?? '0x0000000000000000000000000000000000000000') as `0x${string}`
      await publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_PERMIT_ABI,
        functionName: 'nonces',
        args: [owner],
      })
      await publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_PERMIT_ABI,
        functionName: 'DOMAIN_SEPARATOR',
      })
      return true
    } catch {
      return false
    }
  }, [address, publicClient])

  useEffect(() => {
    if (!token0 && !token1) return
    let cancelled = false

    const probe = async () => {
      const updates: Record<string, boolean> = {}
      const candidates = [token0, token1]
      for (const token of candidates) {
        if (!token || isNativeTokenAddress(token.address)) continue
        const chainToken = toChainTokenAddress(token.address).toLowerCase()
        if (permitSupportMap[chainToken] !== undefined) continue
        updates[chainToken] = await detectPermitSupport(chainToken)
      }

      if (!cancelled && Object.keys(updates).length > 0) {
        setPermitSupportMap((prev) => ({ ...prev, ...updates }))
      }
    }

    probe()
    return () => { cancelled = true }
  }, [token0, token1, detectPermitSupport, permitSupportMap])

  const token0SupportsPermit = Boolean(
    token0 &&
    !isNativeTokenAddress(token0.address) &&
    permitSupportMap[toChainTokenAddress(token0.address).toLowerCase()]
  )
  const token1SupportsPermit = Boolean(
    token1 &&
    !isNativeTokenAddress(token1.address) &&
    permitSupportMap[toChainTokenAddress(token1.address).toLowerCase()]
  )

  // 获取代币余额
  const { data: token0Balance, refetch: refetchToken0Balance } = useBalance({
    address: address,
    token: token0 ? toChainTokenAddress(token0.address) as `0x${string}` : undefined,
    query: {
      enabled: Boolean(address && isConnected && token0),
    },
  })

  const { data: token1Balance, refetch: refetchToken1Balance } = useBalance({
    address: address,
    token: token1 ? toChainTokenAddress(token1.address) as `0x${string}` : undefined,
    query: {
      enabled: Boolean(address && isConnected && token1),
    },
  })

  const { data: nativeBalance, refetch: refetchNativeBalance } = useBalance({
    address,
    query: {
      enabled: Boolean(address && isConnected),
    },
  })

  const tokenList = Object.values(TOKENS)

  const fetchPoolStatus = useCallback(async () => {
    const response = await fetch('/api/pools/check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token0: selectedToken0Address,
        token1: selectedToken1Address,
        fee: selectedFee,
      }),
    }).then(res => res.json())

    if (!response.success) {
      throw new Error(response.error || '搜索池子失败')
    }

    return response
  }, [selectedToken0Address, selectedToken1Address, selectedFee])

  const applyPoolStatus = useCallback((response: { exists: boolean; poolAddress?: string; poolIndex?: number }) => {
    if (response.exists) {
      setPoolExists(true)
      setCurrentPool(response.poolAddress || null)
      setPoolIndex(response.poolIndex ?? null)
      return
    }

    setPoolExists(false)
    setCurrentPool(null)
    setPoolIndex(null)
  }, [])

  // 搜索池子
  const searchPool = useCallback(async () => {
    if (!selectedToken0Address || !selectedToken1Address) {
      setSearchError('请选择两个代币地址')
      return
    }

    if (selectedToken0Address.toLowerCase() === selectedToken1Address.toLowerCase()) {
      setSearchError('请选择不同的代币')
      return
    }

    setStep('searching')
    setIsCheckingPool(true)
    setSearchError(null)
    setTransactionError(null)

    try {
      const response = await fetchPoolStatus()
      applyPoolStatus(response)
      setStep(response.exists ? 'found' : 'notFound')
    } catch (error) {
      console.error('搜索池子失败:', error)
      setSearchError(error instanceof Error ? error.message : '搜索池子失败')
      setPoolExists(false)
      setCurrentPool(null)
      setPoolIndex(null)
      setStep('notFound')
    } finally {
      setIsCheckingPool(false)
    }
  }, [selectedToken0Address, selectedToken1Address, fetchPoolStatus, applyPoolStatus])

  const refreshPoolStatus = useCallback(async () => {
    if (!selectedToken0Address || !selectedToken1Address) return

    setIsCheckingPool(true)
    try {
      const response = await fetchPoolStatus()
      applyPoolStatus(response)
    } catch (error) {
      console.error('刷新池子状态失败:', error)
    } finally {
      setIsCheckingPool(false)
    }
  }, [selectedToken0Address, selectedToken1Address, fetchPoolStatus, applyPoolStatus])

  const refreshBalances = useCallback(async () => {
    await Promise.all([
      refetchToken0Balance(),
      refetchToken1Balance(),
      refetchNativeBalance(),
    ])
  }, [refetchToken0Balance, refetchToken1Balance, refetchNativeBalance])

  const buildPermitCalldata = useCallback(async ({
    tokenAddress,
    tokenName,
    value,
    deadline,
  }: {
    tokenAddress: `0x${string}`
    tokenName: string
    value: bigint
    deadline: bigint
  }): Promise<`0x${string}`> => {
    if (!address || !publicClient) {
      throw new Error('钱包未连接')
    }

    // 优先使用链上 name()/version() 作为 EIP-712 domain，避免前端缓存名称与合约不一致导致签名无效
    let domainName = tokenName
    let domainVersion = '1'
    try {
      const onchainName = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'name',
      })
      if (typeof onchainName === 'string' && onchainName.trim().length > 0) {
        domainName = onchainName
      }
    } catch {
      // keep fallback tokenName
    }
    try {
      const onchainVersion = await publicClient.readContract({
        address: tokenAddress,
        abi: EIP712_VERSION_ABI,
        functionName: 'version',
      })
      if (typeof onchainVersion === 'string' && onchainVersion.trim().length > 0) {
        domainVersion = onchainVersion
      }
    } catch {
      // most ERC20Permit tokens do not expose version(), keep "1"
    }

    const nonce = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_PERMIT_ABI,
      functionName: 'nonces',
      args: [address],
    })

    const signature = await signTypedDataAsync({
      account: address,
      domain: {
        name: domainName,
        version: domainVersion,
        chainId: publicClient.chain?.id ?? selectedChainId,
        verifyingContract: tokenAddress,
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
        spender: CONTRACTS.META_NODE_MANAGER as `0x${string}`,
        value,
        nonce,
        deadline,
      },
    })

    const parsed = parseSignature(signature)
    const permitV = Number(parsed.v ?? (parsed.yParity === 0 ? 27 : 28))
    const { r, s } = parsed

    return encodeFunctionData({
      abi: contractConfig.metaNodeManager.abi,
      functionName: 'selfPermitIfNecessary',
      args: [tokenAddress, value, deadline, permitV, r, s],
    })
  }, [address, publicClient, selectedChainId, signTypedDataAsync])

  const assertBalanceAndAllowance = useCallback(async ({
    tokenAddress,
    amountRequired,
    tokenSymbol,
    tokenDecimals,
  }: {
    tokenAddress: `0x${string}`
    amountRequired: bigint
    tokenSymbol: string
    tokenDecimals: number
  }) => {
    if (!address || !publicClient || amountRequired <= 0n) return

    const bytecode = await publicClient.getBytecode({
      address: tokenAddress,
    })
    if (!bytecode || bytecode === '0x') {
      throw new Error(
        `${tokenSymbol} 合约地址在当前网络不存在：${tokenAddress}。请确认钱包已切换到 Sepolia，且 WETH 地址配置正确。`
      )
    }

    let balance: bigint
    let allowance: bigint
    try {
      [balance, allowance] = await Promise.all([
        publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        }),
        publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address, CONTRACTS.META_NODE_MANAGER as `0x${string}`],
        }),
      ])
    } catch (error) {
      if (error instanceof BaseError) {
        throw new Error(
          `${tokenSymbol} 读取余额/授权失败，请确认当前网络与代币地址匹配（${tokenAddress}）。${error.shortMessage ?? ''}`.trim()
        )
      }
      throw error
    }

    if (balance < amountRequired) {
      throw new Error(
        `${tokenSymbol} 余额不足（需要 ${formatUnits(amountRequired, tokenDecimals)}，当前 ${formatUnits(balance, tokenDecimals)}）`
      )
    }

    if (allowance < amountRequired) {
      throw new Error(
        `${tokenSymbol} 授权不足（需要 ${formatUnits(amountRequired, tokenDecimals)}，当前 ${formatUnits(allowance, tokenDecimals)}）`
      )
    }
  }, [address, publicClient])

  // 检查授权
  const checkAllowance = useCallback(async () => {
    if (!address || !token0 || !token1 || !amount0 || !amount1) {
      setNeedsApproval0(false)
      setNeedsApproval1(false)
      return
    }

    try {
      setIsCheckingAllowance(true)
      setTransactionError(null)
      const allowance0Response = await fetch('/api/allowance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: toChainTokenAddress(token0.address),
          owner: address,
          spender: CONTRACTS.META_NODE_MANAGER,
        }),
      }).then(res => res.json())

      const allowance1Response = await fetch('/api/allowance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: toChainTokenAddress(token1.address),
          owner: address,
          spender: CONTRACTS.META_NODE_MANAGER,
        }),
      }).then(res => res.json())

      if (allowance0Response.success && allowance1Response.success) {
        const amountWei0 = parseUnits(amount0, token0.decimals)
        const amountWei1 = parseUnits(amount1, token1.decimals)
        const canSkipApprove0 = ENABLE_PERMIT_LIQUIDITY && token0SupportsPermit
        const canSkipApprove1 = ENABLE_PERMIT_LIQUIDITY && token1SupportsPermit

        setNeedsApproval0(!canSkipApprove0 && BigInt(allowance0Response.allowance) < amountWei0)
        setNeedsApproval1(!canSkipApprove1 && BigInt(allowance1Response.allowance) < amountWei1)
      }
    } catch (error) {
      console.error('检查授权失败:', error)
      // API 异常时采用保守策略：默认需要授权，避免直接发交易后在链上失败
      setNeedsApproval0(Boolean(token0 && !isNativeTokenAddress(token0.address)))
      setNeedsApproval1(Boolean(token1 && !isNativeTokenAddress(token1.address)))
    } finally {
      setIsCheckingAllowance(false)
    }
  }, [address, token0, token1, amount0, amount1, token0SupportsPermit, token1SupportsPermit])

  useEffect(() => {
    checkAllowance()
  }, [amount0, amount1, token0, token1, address, checkAllowance])

  // 授权代币
  const approveToken = useCallback(async (tokenAddress: string, amount: string, decimals: number) => {
    if (!address) return

    try {
      const amountWei = parseUnits(amount, decimals)
      const actualTokenAddress = toChainTokenAddress(tokenAddress)
      setTransactionAction(tokenAddress === token0?.address ? 'approve0' : 'approve1')
      setTransactionError(null)

      await writeContractWithEstimatedGas({
        address: actualTokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [CONTRACTS.META_NODE_MANAGER as `0x${string}`, amountWei],
      })
    } catch (error) {
      setTransactionAction(null)
      setTransactionError(getErrorMessage(error))
    }
  }, [address, token0?.address, writeContractWithEstimatedGas, getErrorMessage])

  // 计算初始价格对应的 sqrtPriceX96
  const calculateSqrtPriceX96 = useCallback((price: string): bigint => {
    try {
      const priceRatio = parseFloat(price)
      if (priceRatio <= 0 || !isFinite(priceRatio)) {
        return BigInt(0)
      }
      
      // sqrtPriceX96 = sqrt(price) * 2^96
      // price = reserve1 / reserve0
      // 使用简化的计算方式
      const Q96 = BigInt(2) ** BigInt(96)
      const sqrtPrice = Math.sqrt(priceRatio)
      return BigInt(Math.floor(sqrtPrice * Number(Q96)))
    } catch {
      return BigInt(0)
    }
  }, [])

  // 创建池子并添加初始流动性
  const createPoolAndAddLiquidity = useCallback(async () => {
    if (!address || !amount0 || !amount1 || !token0 || !token1) return

    try {
      const amountWei0 = parseUnits(amount0, token0.decimals)
      const amountWei1 = parseUnits(amount1, token1.decimals)
      const actualToken0Address = toChainTokenAddress(token0.address)
      const actualToken1Address = toChainTokenAddress(token1.address)

      // 确保 token0 地址小于 token1 地址，并同步对应 metadata（name/permit）
      let sortedToken0Address = actualToken0Address
      let sortedToken1Address = actualToken1Address
      let sortedAmount0 = amountWei0
      let sortedAmount1 = amountWei1
      let sortedToken0Name = token0.name
      let sortedToken1Name = token1.name
      let sortedToken0SupportsPermit = token0SupportsPermit
      let sortedToken1SupportsPermit = token1SupportsPermit

      if (BigInt(actualToken0Address) > BigInt(actualToken1Address)) {
        sortedToken0Address = actualToken1Address
        sortedToken1Address = actualToken0Address
        sortedAmount0 = amountWei1
        sortedAmount1 = amountWei0
        sortedToken0Name = token1.name
        sortedToken1Name = token0.name
        sortedToken0SupportsPermit = token1SupportsPermit
        sortedToken1SupportsPermit = token0SupportsPermit
      }

      const sortedToken0Decimals = BigInt(actualToken0Address) > BigInt(actualToken1Address) ? token1.decimals : token0.decimals
      const sortedToken1Decimals = BigInt(actualToken0Address) > BigInt(actualToken1Address) ? token0.decimals : token1.decimals

      await assertBalanceAndAllowance({
        tokenAddress: sortedToken0Address as `0x${string}`,
        amountRequired: sortedAmount0,
        tokenSymbol: sortedToken0Name,
        tokenDecimals: sortedToken0Decimals,
      })
      await assertBalanceAndAllowance({
        tokenAddress: sortedToken1Address as `0x${string}`,
        amountRequired: sortedAmount1,
        tokenSymbol: sortedToken1Name,
        tokenDecimals: sortedToken1Decimals,
      })

      // 计算初始价格
      const priceRatio = parseFloat(initialPrice)
      if (priceRatio <= 0 || !isFinite(priceRatio)) {
        setPriceError('请输入有效的价格比率')
        return
      }

      // 计算 sqrtPriceX96
      // 注意：如果 token0 和 token1 交换了，价格也需要调整
      const actualPrice = BigInt(actualToken0Address) < BigInt(actualToken1Address) 
        ? priceRatio 
        : 1 / priceRatio
      
      const sqrtPriceX96 = calculateSqrtPriceX96(actualPrice.toString())
      if (sqrtPriceX96 === BigInt(0)) {
        setPriceError('价格计算失败，请检查输入')
        return
      }

      setPriceError(null)

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
      const multicallData: `0x${string}`[] = []

      if (ENABLE_PERMIT_LIQUIDITY && sortedToken0SupportsPermit && !isNativeTokenAddress(sortedToken0Address)) {
        multicallData.push(
          await buildPermitCalldata({
            tokenAddress: sortedToken0Address as `0x${string}`,
            tokenName: sortedToken0Name,
            value: sortedAmount0,
            deadline,
          })
        )
      }

      if (ENABLE_PERMIT_LIQUIDITY && sortedToken1SupportsPermit && !isNativeTokenAddress(sortedToken1Address)) {
        multicallData.push(
          await buildPermitCalldata({
            tokenAddress: sortedToken1Address as `0x${string}`,
            tokenName: sortedToken1Name,
            value: sortedAmount1,
            deadline,
          })
        )
      }

      const createAndAddLiquidityCalldata = encodeFunctionData({
        abi: contractConfig.metaNodeManager.abi,
        functionName: 'createAndAddLiquidity',
        args: [
          {
            token0: sortedToken0Address as `0x${string}`,
            token1: sortedToken1Address as `0x${string}`,
            fee: selectedFee,
            tickLower: -887272,
            tickUpper: 887272,
            sqrtPriceX96,
          },
          {
            token0: sortedToken0Address as `0x${string}`,
            token1: sortedToken1Address as `0x${string}`,
            index: 0,
            amount0Desired: sortedAmount0,
            amount1Desired: sortedAmount1,
            recipient: address,
            deadline,
          },
        ],
      })
      multicallData.push(createAndAddLiquidityCalldata)

      // 通过 MetaNodeManager.multicall 一笔完成「permit(可选) + 创建池子 + 添加流动性」
      setTransactionAction('createPool')
      setTransactionError(null)
      await writeMetaNodeManagerMulticall(multicallData)
    } catch (error) {
      console.error('创建池子失败:', error)
      setTransactionAction(null)
      setPriceError(getErrorMessage(error))
    }
  }, [address, amount0, amount1, token0, token1, selectedFee, initialPrice, calculateSqrtPriceX96, writeMetaNodeManagerMulticall, getErrorMessage, token0SupportsPermit, token1SupportsPermit, buildPermitCalldata, assertBalanceAndAllowance])

  // 添加流动性到已存在的池子
  const addLiquidity = useCallback(async () => {
    if (!address || !amount0 || !amount1 || !token0 || !token1 || !currentPool || poolIndex === null) return

    try {
      const latestPoolStatus = await fetchPoolStatus()
      applyPoolStatus(latestPoolStatus)

      if (!latestPoolStatus.exists || latestPoolStatus.poolIndex === undefined) {
        throw new Error('当前费率下未找到可用池子，请重新搜索资金池')
      }

      const amountWei0 = parseUnits(amount0, token0.decimals)
      const amountWei1 = parseUnits(amount1, token1.decimals)
      const actualToken0Address = toChainTokenAddress(token0.address)
      const actualToken1Address = toChainTokenAddress(token1.address)

      // 确保 token0 地址小于 token1 地址，并同步对应 metadata（name/permit）
      let sortedToken0Address = actualToken0Address
      let sortedToken1Address = actualToken1Address
      let sortedAmount0 = amountWei0
      let sortedAmount1 = amountWei1
      let sortedToken0Name = token0.name
      let sortedToken1Name = token1.name
      let sortedToken0SupportsPermit = token0SupportsPermit
      let sortedToken1SupportsPermit = token1SupportsPermit

      if (BigInt(actualToken0Address) > BigInt(actualToken1Address)) {
        sortedToken0Address = actualToken1Address
        sortedToken1Address = actualToken0Address
        sortedAmount0 = amountWei1
        sortedAmount1 = amountWei0
        sortedToken0Name = token1.name
        sortedToken1Name = token0.name
        sortedToken0SupportsPermit = token1SupportsPermit
        sortedToken1SupportsPermit = token0SupportsPermit
      }

      const sortedToken0Decimals = BigInt(actualToken0Address) > BigInt(actualToken1Address) ? token1.decimals : token0.decimals
      const sortedToken1Decimals = BigInt(actualToken0Address) > BigInt(actualToken1Address) ? token0.decimals : token1.decimals

      await assertBalanceAndAllowance({
        tokenAddress: sortedToken0Address as `0x${string}`,
        amountRequired: sortedAmount0,
        tokenSymbol: sortedToken0Name,
        tokenDecimals: sortedToken0Decimals,
      })
      await assertBalanceAndAllowance({
        tokenAddress: sortedToken1Address as `0x${string}`,
        amountRequired: sortedAmount1,
        tokenSymbol: sortedToken1Name,
        tokenDecimals: sortedToken1Decimals,
      })

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
      const multicallData: `0x${string}`[] = []

      if (ENABLE_PERMIT_LIQUIDITY && sortedToken0SupportsPermit && !isNativeTokenAddress(sortedToken0Address)) {
        multicallData.push(
          await buildPermitCalldata({
            tokenAddress: sortedToken0Address as `0x${string}`,
            tokenName: sortedToken0Name,
            value: sortedAmount0,
            deadline,
          })
        )
      }

      if (ENABLE_PERMIT_LIQUIDITY && sortedToken1SupportsPermit && !isNativeTokenAddress(sortedToken1Address)) {
        multicallData.push(
          await buildPermitCalldata({
            tokenAddress: sortedToken1Address as `0x${string}`,
            tokenName: sortedToken1Name,
            value: sortedAmount1,
            deadline,
          })
        )
      }

      const addLiquidityCalldata = encodeFunctionData({
        abi: contractConfig.metaNodeManager.abi,
        functionName: 'addLiquidity',
        args: [{
          token0: sortedToken0Address as `0x${string}`,
          token1: sortedToken1Address as `0x${string}`,
          index: latestPoolStatus.poolIndex,
          amount0Desired: sortedAmount0,
          amount1Desired: sortedAmount1,
          recipient: address,
          deadline,
        }],
      })
      multicallData.push(addLiquidityCalldata)

      // 通过 MetaNodeManager.multicall 执行「permit(可选) + 添加流动性」
      setTransactionAction('addLiquidity')
      setTransactionError(null)
      await writeMetaNodeManagerMulticall(multicallData)
    } catch (error) {
      console.error('添加流动性失败:', error)
      setTransactionAction(null)
      setTransactionError(getErrorMessage(error))
    }
  }, [address, amount0, amount1, token0, token1, currentPool, poolIndex, fetchPoolStatus, applyPoolStatus, writeMetaNodeManagerMulticall, getErrorMessage, token0SupportsPermit, token1SupportsPermit, buildPermitCalldata, assertBalanceAndAllowance])

  // 计算对应数量
  const calculateAmount = useCallback(async (inputToken: 'token0' | 'token1', amount: string) => {
    if (!amount || parseFloat(amount) === 0) {
      if (inputToken === 'token0') {
        setAmount1('')
      } else {
        setAmount0('')
      }
      setPriceError(null)
      return
    }

    setIsCalculating(true)
    setPriceError(null)

    try {
      if (poolExists && currentPool && token0 && token1) {
        // 如果池子存在，使用池子价格计算
        const response = await fetch('/api/pools/price', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            poolAddress: currentPool,
            inputToken: inputToken === 'token0' ? token0.address : token1.address,
            inputAmount: amount,
          }),
        })

        const data = await response.json()

        if (!response.ok || !data.success) {
          const errorMsg = data.msg || data.error || '计算价格失败'
          setPriceError(errorMsg)
          // 如果计算失败，清空对应的输出金额
          if (inputToken === 'token0') {
            setAmount1('')
          } else {
            setAmount0('')
          }
          return
        }

        // 成功计算
        if (inputToken === 'token0') {
          setAmount1(data.outputAmount)
        } else {
          setAmount0(data.outputAmount)
        }
        setPriceError(null)
      } else {
        // 如果池子不存在，使用初始价格比率计算
        const priceRatio = parseFloat(initialPrice)
        if (priceRatio > 0 && isFinite(priceRatio)) {
          try {
            if (inputToken === 'token0') {
              const calculated = parseFloat(amount) * priceRatio
              setAmount1(isNaN(calculated) ? '' : calculated.toString())
            } else {
              const calculated = parseFloat(amount) / priceRatio
              setAmount0(isNaN(calculated) ? '' : calculated.toString())
            }
            setPriceError(null)
          } catch (calcError) {
            console.error('价格计算错误:', calcError)
            setPriceError('价格计算失败，请检查输入')
            if (inputToken === 'token0') {
              setAmount1('')
            } else {
              setAmount0('')
            }
          }
        } else {
          // 默认 1:1
          if (inputToken === 'token0') {
            setAmount1(amount)
          } else {
            setAmount0(amount)
          }
          setPriceError(null)
        }
      }
    } catch (error) {
      console.error('计算数量失败:', error)
      const errorMsg = error instanceof Error ? error.message : '计算价格失败'
      setPriceError(errorMsg)
      // 清空对应的输出金额
      if (inputToken === 'token0') {
        setAmount1('')
      } else {
        setAmount0('')
      }
    } finally {
      setIsCalculating(false)
    }
  }, [poolExists, currentPool, token0, token1, initialPrice])

  const handleAmount0Change = (value: string) => {
    const parsed = parseInputAmount(value)
    setAmount0(parsed)
    calculateAmount('token0', parsed)
  }

  const handleAmount1Change = (value: string) => {
    const parsed = parseInputAmount(value)
    setAmount1(parsed)
    calculateAmount('token1', parsed)
  }

  const handleInitialPriceChange = (value: string) => {
    const parsed = parseInputAmount(value)
    setInitialPrice(parsed)
    // 重新计算数量
    if (amount0) {
      calculateAmount('token0', amount0)
    } else if (amount1) {
      calculateAmount('token1', amount1)
    }
  }

  const handleMaxAmount0 = () => {
    const maxBalance = token0 && isNativeTokenAddress(token0.address) ? nativeBalance : token0Balance
    if (maxBalance) {
      setAmount0(maxBalance.formatted)
      calculateAmount('token0', maxBalance.formatted)
    }
  }

  const handleMaxAmount1 = () => {
    const maxBalance = token1 && isNativeTokenAddress(token1.address) ? nativeBalance : token1Balance
    if (maxBalance) {
      setAmount1(maxBalance.formatted)
      calculateAmount('token1', maxBalance.formatted)
    }
  }

  const hasInsufficientBalance0 = (() => {
    const availableBalance = token0 && isNativeTokenAddress(token0.address) ? nativeBalance : token0Balance
    if (!token0 || !availableBalance || !amount0) return false
    try {
      return parseUnits(amount0, token0.decimals) > availableBalance.value
    } catch {
      return false
    }
  })()

  const hasInsufficientBalance1 = (() => {
    const availableBalance = token1 && isNativeTokenAddress(token1.address) ? nativeBalance : token1Balance
    if (!token1 || !availableBalance || !amount1) return false
    try {
      return parseUnits(amount1, token1.decimals) > availableBalance.value
    } catch {
      return false
    }
  })()

  const needsWrap0 = (() => {
    if (!token0 || !isNativeTokenAddress(token0.address) || !token0Balance || !amount0) return false
    try {
      return parseUnits(amount0, token0.decimals) > token0Balance.value
    } catch {
      return false
    }
  })()

  const needsWrap1 = (() => {
    if (!token1 || !isNativeTokenAddress(token1.address) || !token1Balance || !amount1) return false
    try {
      return parseUnits(amount1, token1.decimals) > token1Balance.value
    } catch {
      return false
    }
  })()

  const wrapToken = useCallback(async (token: Token, amount: string, currentWrappedBalance?: bigint) => {
    if (!address || !isNativeTokenAddress(token.address)) return

    try {
      const desiredAmount = parseUnits(amount, token.decimals)
      const wrappedBalance = currentWrappedBalance ?? BigInt(0)
      const wrapAmount = desiredAmount > wrappedBalance ? desiredAmount - wrappedBalance : BigInt(0)

      if (wrapAmount <= 0) return

      setTransactionAction(token.address === token0?.address ? 'wrap0' : 'wrap1')
      setTransactionError(null)

      await writeContractWithEstimatedGas({
        address: TOKENS.ETH.wrappedAddress as `0x${string}`,
        abi: WETH_ABI,
        functionName: 'deposit',
        args: [],
        value: wrapAmount,
      })
    } catch (error) {
      setTransactionAction(null)
      setTransactionError(getErrorMessage(error))
    }
  }, [address, token0?.address, writeContractWithEstimatedGas, getErrorMessage])

  const handleSwapTokens = () => {
    const temp = selectedToken0Address
    setSelectedToken0Address(selectedToken1Address)
    setSelectedToken1Address(temp)
    if (token0 && token1) {
      setToken0(token1)
      setToken1(token0)
      setAmount0(amount1)
      setAmount1(amount0)
      // 交换价格比率
      const priceRatio = parseFloat(initialPrice)
      if (priceRatio > 0 && isFinite(priceRatio)) {
        setInitialPrice((1 / priceRatio).toString())
      }
    }
  }

  // 使用找到的池子
  const useFoundPool = () => {
    setStep('addLiquidity')
  }

  // 创建新池子
  const createNewPool = () => {
    setStep('addLiquidity')
  }

  // 返回重新选择
  const backToSelect = () => {
    setStep('select')
    setSearchError(null)
    setPriceError(null)
    setTransactionError(null)
  }

  // 交易成功后刷新池子状态
  useEffect(() => {
    if (!isConfirmed || step !== 'addLiquidity' || !transactionAction) return

    const timer = setTimeout(() => {
      ;(async () => {
        if (transactionAction === 'wrap0' || transactionAction === 'wrap1') {
          await refreshBalances()
          await checkAllowance()
        }

        if (transactionAction === 'approve0' || transactionAction === 'approve1') {
          await refreshBalances()
          await checkAllowance()
        }

        if (transactionAction === 'createPool') {
          await refreshPoolStatus()
          await refreshBalances()
        }

        if (transactionAction === 'addLiquidity') {
          await refreshPoolStatus()
          await refreshBalances()
          await checkAllowance()
        }

        setTransactionAction(null)
      })()
    }, 1500)

    return () => clearTimeout(timer)
  }, [isConfirmed, step, transactionAction, refreshPoolStatus, refreshBalances, checkAllowance])

  const TokenSelector = ({ 
    selectedToken, 
    onSelect, 
    label,
    otherToken
  }: { 
    selectedToken: Token
    onSelect: (token: Token) => void
    label: string
    otherToken: Token
  }) => {
    const [isOpen, setIsOpen] = useState(false)

    return (
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center space-x-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground px-3 py-2 rounded-lg transition-colors"
        >
          <div className="w-6 h-6 bg-gradient-to-r from-blue-500 to-purple-600 rounded-full flex items-center justify-center">
            <span className="text-white text-xs font-bold">{selectedToken.symbol[0]}</span>
          </div>
          <span className="font-medium">{selectedToken.symbol}</span>
          <ChevronDown className="w-4 h-4" />
        </button>

        {isOpen && (
          <div className="absolute top-full mt-1 w-48 bg-background border border-border rounded-lg shadow-lg z-50">
            <div className="p-2">
              <div className="text-sm text-muted-foreground px-2 py-1">{label}</div>
              {tokenList.map((token) => (
                <button
                  key={token.address}
                  onClick={() => {
                    onSelect(token)
                    // alert(token.address)
                    setIsOpen(false)
                  }}
                  disabled={token.address === otherToken.address}
                  className={cn(
                    "w-full flex items-center space-x-3 px-2 py-2 rounded transition-colors",
                    selectedToken.address === token.address && "bg-accent",
                    token.address === otherToken.address ? "opacity-50 cursor-not-allowed" : "hover:bg-accent"
                  )}
                >
                  <div className="w-6 h-6 bg-gradient-to-r from-blue-500 to-purple-600 rounded-full flex items-center justify-center">
                    <span className="text-white text-xs font-bold">{token.symbol[0]}</span>
                  </div>
                  <div className="text-left">
                    <div className="font-medium text-foreground">{token.symbol}</div>
                    <div className="text-sm text-muted-foreground">{token.name}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  // 交易状态显示
  const TransactionStatus = () => {
    if (!hash) return null

    const actionLabel = transactionAction === 'approve0' || transactionAction === 'approve1'
      ? '授权'
      : transactionAction === 'wrap0' || transactionAction === 'wrap1'
      ? '包装 ETH'
      : transactionAction === 'createPool'
      ? '创建池子'
      : transactionAction === 'addLiquidity'
      ? '添加流动性'
      : '交易'

    return (
      <div className="mb-6 p-4 bg-primary/10 border border-primary/20 rounded-lg">
        <div className="flex items-center space-x-2">
          {isPending && (
            <>
              <Clock className="w-5 h-5 text-primary animate-spin" />
              <span className="text-primary">{actionLabel}等待钱包确认...</span>
            </>
          )}
          {isConfirming && (
            <>
              <Clock className="w-5 h-5 text-primary animate-spin" />
              <span className="text-primary">{actionLabel}确认中...</span>
            </>
          )}
          {isConfirmed && (
            <>
              <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
              <span className="text-green-700 dark:text-green-300">{actionLabel}成功！</span>
            </>
          )}
        </div>
        <div className="mt-2 text-sm text-primary">
          交易哈希: {shortenAddress(hash)}
        </div>
      </div>
    )
  }

  // 选择界面
  const renderSelectStep = () => (
    <>
      <div className="mb-6">
        <h3 className="text-lg font-semibold text-card-foreground mb-4">选择交易对参数</h3>
        
        {/* Token0 Address */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            代币 0 地址
          </label>
          <div className="flex space-x-2">
            <input
              type="text"
              value={selectedToken0Address}
              onChange={(e) => setSelectedToken0Address(e.target.value)}
              placeholder="0x..."
              className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <TokenSelector
              selectedToken={token0 || tokenList[0]}
              onSelect={(token) => {
                setSelectedToken0Address(token.address)
                setToken0(token)
              }}
              label="快速选择"
              otherToken={token1 || tokenList[1]}
            />
          </div>
        </div>

        {/* Token1 Address */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            代币 1 地址
          </label>
          <div className="flex space-x-2">
            <input
              type="text"
              value={selectedToken1Address}
              onChange={(e) => setSelectedToken1Address(e.target.value)}
              placeholder="0x..."
              className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <TokenSelector
              selectedToken={token1 || tokenList[1]}
              onSelect={(token) => {
                setSelectedToken1Address(token.address)
                setToken1(token)
              }}
              label="快速选择"
              otherToken={token0 || tokenList[0]}
            />
          </div>
        </div>

        {/* Fee Selection */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            费率
          </label>
          <div className="flex space-x-2">
            {FEE_TIERS.map((feeValue) => (
              <button
                key={feeValue}
                onClick={() => setSelectedFee(feeValue)}
                className={cn(
                  "px-3 py-2 rounded text-sm transition-colors flex-1",
                  selectedFee === feeValue 
                    ? "bg-primary text-primary-foreground" 
                    : "bg-muted hover:bg-accent"
                )}
              >
                {feeValue / 10000}%
              </button>
            ))}
          </div>
        </div>

        {/* Chain ID */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            链 ID
          </label>
          <input
            type="number"
            value={selectedChainId}
            onChange={(e) => setSelectedChainId(parseInt(e.target.value) || 11155111)}
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <div className="mt-1 text-xs text-muted-foreground">
            当前: Sepolia (11155111)
          </div>
        </div>

        {searchError && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <div className="flex items-center">
              <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 mr-2" />
              <span className="text-sm text-red-600 dark:text-red-400">{searchError}</span>
            </div>
          </div>
        )}

        <button
          onClick={searchPool}
          disabled={!selectedToken0Address || !selectedToken1Address || isCheckingPool}
          className={cn(
            "w-full py-4 rounded-lg font-medium text-lg transition-colors",
            !selectedToken0Address || !selectedToken1Address || isCheckingPool
              ? "bg-muted text-muted-foreground cursor-not-allowed"
              : "bg-primary hover:bg-primary/90 text-primary-foreground"
          )}
        >
          {isCheckingPool ? '搜索中...' : '搜索资金池'}
        </button>
      </div>
    </>
  )

  // 搜索结果界面 - 找到池子
  const renderFoundStep = () => (
    <>
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-card-foreground">找到可复用的池子</h3>
          <button
            onClick={backToSelect}
            className="text-sm text-primary hover:text-primary/80"
          >
            重新选择
          </button>
        </div>

        <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg mb-4">
          <div className="flex items-center mb-2">
            <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400 mr-2" />
            <span className="font-medium text-green-800 dark:text-green-200">池子已存在</span>
          </div>
          <div className="text-sm text-green-700 dark:text-green-300 space-y-1">
            <div>池子地址: {currentPool ? shortenAddress(currentPool) : 'N/A'}</div>
            <div>费率: {selectedFee / 10000}%</div>
            {poolIndex !== null && <div>池子索引: {poolIndex}</div>}
          </div>
        </div>

        <div className="flex space-x-3">
          <button
            onClick={useFoundPool}
            className="flex-1 py-3 rounded-lg font-medium bg-primary hover:bg-primary/90 text-primary-foreground transition-colors"
          >
            使用此池子
          </button>
          <button
            onClick={createNewPool}
            className="flex-1 py-3 rounded-lg font-medium bg-muted hover:bg-accent text-foreground transition-colors"
          >
            创建新池子
          </button>
        </div>
      </div>
    </>
  )

  // 搜索结果界面 - 未找到池子
  const renderNotFoundStep = () => (
    <>
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-card-foreground">未找到池子</h3>
          <button
            onClick={backToSelect}
            className="text-sm text-primary hover:text-primary/80"
          >
            重新选择
          </button>
        </div>

        <div className="p-4 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg mb-4">
          <div className="flex items-center mb-2">
            <AlertCircle className="w-5 h-5 text-orange-600 dark:text-orange-400 mr-2" />
            <span className="font-medium text-orange-800 dark:text-orange-200">未找到匹配的池子</span>
          </div>
          <div className="text-sm text-orange-700 dark:text-orange-300">
            将创建新的资金池
          </div>
        </div>

        <button
          onClick={createNewPool}
          className="w-full py-4 rounded-lg font-medium bg-primary hover:bg-primary/90 text-primary-foreground transition-colors"
        >
          创建新池子
        </button>
      </div>
    </>
  )

  // 添加流动性界面
  const renderAddLiquidityStep = () => (
    <>
      {/* Pool Status */}
      <div className="mb-4 p-3 bg-muted rounded-lg">
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">池子状态</span>
          <span className={cn(
            "text-sm font-medium",
            isCheckingPool
              ? "text-primary"
              : poolExists
              ? "text-green-600 dark:text-green-400"
              : "text-orange-600 dark:text-orange-400"
          )}>
            {isCheckingPool ? "检查中" : poolExists ? "已存在" : "未创建"}
          </span>
        </div>
        {currentPool && (
          <div className="mt-1 text-xs text-muted-foreground">
            池子地址: {shortenAddress(currentPool)}
          </div>
        )}
      </div>

      {/* Fee Selection (只读) */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-muted-foreground">费率</span>
        </div>
        <div className="flex space-x-2">
          {FEE_TIERS.map((feeValue) => (
            <button
              key={feeValue}
              disabled
              className={cn(
                "px-3 py-2 rounded text-sm flex-1",
                selectedFee === feeValue 
                  ? "bg-primary text-primary-foreground" 
                  : "bg-muted opacity-50"
              )}
            >
              {feeValue / 10000}%
            </button>
          ))}
        </div>
      </div>

      {/* Initial Price (only show when pool doesn't exist) */}
      {!poolExists && token0 && token1 && (
        <div className="mb-4 p-4 bg-muted rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center space-x-2">
              <span className="text-sm font-medium text-foreground">初始价格</span>
              <Info className="w-4 h-4 text-muted-foreground" />
            </div>
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            设置 {token0.symbol} 与 {token1.symbol} 的初始价格比率
          </div>
          <div className="flex items-center space-x-2">
            <span className="text-sm text-muted-foreground">1 {token0.symbol} =</span>
            <input
              type="text"
              value={initialPrice}
              onChange={(e) => handleInitialPriceChange(e.target.value)}
              placeholder="1"
              className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <span className="text-sm text-muted-foreground">{token1.symbol}</span>
          </div>
          {priceError && (
            <div className="mt-2 text-xs text-red-600 dark:text-red-400">
              {priceError}
            </div>
          )}
        </div>
      )}

      {(token0 && isNativeTokenAddress(token0.address)) || (token1 && isNativeTokenAddress(token1.address)) ? (
        <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-sm text-amber-700 dark:text-amber-300">
          如果你选择了原生 `ETH`，本页会先引导你把所需数量包装成 `WETH`，然后再执行授权和添加流动性。
        </div>
      ) : null}

      {transactionError && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <div className="flex items-center">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 mr-2" />
            <span className="text-sm text-red-600 dark:text-red-400">{transactionError}</span>
          </div>
        </div>
      )}

      {(hasInsufficientBalance0 || hasInsufficientBalance1) && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <div className="flex items-center">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 mr-2" />
            <span className="text-sm text-red-600 dark:text-red-400">
              {hasInsufficientBalance0
                ? `${isNativeTokenAddress(token0?.address) ? 'ETH' : getRequiredBalanceLabel(token0)} 余额不足`
                : `${isNativeTokenAddress(token1?.address) ? 'ETH' : getRequiredBalanceLabel(token1)} 余额不足`}
            </span>
          </div>
        </div>
      )}

      {/* Token0 Input */}
      {token0 && token1 && (
        <>
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">代币 1</span>
              <div className="flex items-center space-x-2">
                <span className="text-sm text-muted-foreground">
                  余额: {token0 && isNativeTokenAddress(token0.address)
                    ? (nativeBalance ? formatTokenAmount(nativeBalance.formatted) : '0')
                    : (token0Balance ? formatTokenAmount(token0Balance.formatted) : '0')}
                </span>
                {(token0 && isNativeTokenAddress(token0.address) ? nativeBalance : token0Balance) &&
                  parseFloat((token0 && isNativeTokenAddress(token0.address) ? nativeBalance : token0Balance)!.formatted) > 0 && (
                  <button
                    onClick={handleMaxAmount0}
                    className="text-xs text-primary hover:text-primary/80 font-medium"
                  >
                    最大
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
              <input
                type="text"
                value={amount0}
                onChange={(e) => handleAmount0Change(e.target.value)}
                placeholder="0"
                className="text-2xl font-medium bg-transparent outline-none flex-1 text-foreground placeholder:text-muted-foreground"
              />
              <div className="px-3 py-2 bg-secondary rounded-lg">
                <span className="font-medium text-secondary-foreground">{token0.symbol}</span>
              </div>
            </div>
          </div>

          {/* Swap Arrow */}
          <div className="flex justify-center mb-4">
            <button
              onClick={handleSwapTokens}
              className="p-2 bg-muted hover:bg-accent border border-border rounded-lg transition-colors"
            >
              <ArrowUpDown className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>

          {/* Token1 Input */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">代币 2</span>
              <div className="flex items-center space-x-2">
                <span className="text-sm text-muted-foreground">
                  余额: {token1 && isNativeTokenAddress(token1.address)
                    ? (nativeBalance ? formatTokenAmount(nativeBalance.formatted) : '0')
                    : (token1Balance ? formatTokenAmount(token1Balance.formatted) : '0')}
                </span>
                {(token1 && isNativeTokenAddress(token1.address) ? nativeBalance : token1Balance) &&
                  parseFloat((token1 && isNativeTokenAddress(token1.address) ? nativeBalance : token1Balance)!.formatted) > 0 && (
                  <button
                    onClick={handleMaxAmount1}
                    className="text-xs text-primary hover:text-primary/80 font-medium"
                  >
                    最大
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
              <div className="flex items-center flex-1">
                <div className="text-2xl font-medium text-foreground flex-1">
                  {isCalculating ? (
                    <div className="flex items-center">
                      <Clock className="w-4 h-4 animate-spin mr-2 text-muted-foreground" />
                      <span className="text-muted-foreground">计算中...</span>
                    </div>
                  ) : (
                    amount1 || '0'
                  )}
                </div>
              </div>
              <div className="px-3 py-2 bg-secondary rounded-lg">
                <span className="font-medium text-secondary-foreground">{token1.symbol}</span>
              </div>
            </div>
            {priceError && (
              <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                ⚠️ {priceError}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          {!isConnected ? (
            <button
              disabled
              className="w-full py-4 rounded-lg font-medium text-lg bg-muted text-muted-foreground cursor-not-allowed"
            >
              请先连接钱包
            </button>
          ) : needsWrap0 ? (
            <button
              onClick={() => wrapToken(token0, amount0, token0Balance?.value)}
              disabled={isPending || isConfirming || hasInsufficientBalance0 || !amount0}
              className={cn(
                "w-full py-4 rounded-lg font-medium text-lg transition-colors",
                isPending || isConfirming || hasInsufficientBalance0 || !amount0
                  ? "bg-muted text-muted-foreground cursor-not-allowed"
                  : "bg-blue-500 hover:bg-blue-600 text-white"
              )}
            >
              {isPending || isConfirming ? '包装中...' : `先将 ETH 包装为 WETH`}
            </button>
          ) : needsWrap1 ? (
            <button
              onClick={() => wrapToken(token1, amount1, token1Balance?.value)}
              disabled={isPending || isConfirming || hasInsufficientBalance1 || !amount1}
              className={cn(
                "w-full py-4 rounded-lg font-medium text-lg transition-colors",
                isPending || isConfirming || hasInsufficientBalance1 || !amount1
                  ? "bg-muted text-muted-foreground cursor-not-allowed"
                  : "bg-blue-500 hover:bg-blue-600 text-white"
              )}
            >
              {isPending || isConfirming ? '包装中...' : `先将 ETH 包装为 WETH`}
            </button>
          ) : needsApproval0 ? (
            <button
              onClick={() => approveToken(token0.address, amount0, token0.decimals)}
              disabled={isPending || isConfirming || isCheckingAllowance || hasInsufficientBalance0 || !amount0}
              className={cn(
                "w-full py-4 rounded-lg font-medium text-lg transition-colors",
                isPending || isConfirming || isCheckingAllowance || hasInsufficientBalance0 || !amount0
                  ? "bg-muted text-muted-foreground cursor-not-allowed"
                  : "bg-yellow-500 hover:bg-yellow-600 text-white"
              )}
            >
              {isPending || isConfirming ? '授权中...' : isCheckingAllowance ? '检查授权中...' : `授权 ${token0.symbol}`}
            </button>
          ) : needsApproval1 ? (
            <button
              onClick={() => approveToken(token1.address, amount1, token1.decimals)}
              disabled={isPending || isConfirming || isCheckingAllowance || hasInsufficientBalance1 || !amount1}
              className={cn(
                "w-full py-4 rounded-lg font-medium text-lg transition-colors",
                isPending || isConfirming || isCheckingAllowance || hasInsufficientBalance1 || !amount1
                  ? "bg-muted text-muted-foreground cursor-not-allowed"
                  : "bg-yellow-500 hover:bg-yellow-600 text-white"
              )}
            >
              {isPending || isConfirming ? '授权中...' : isCheckingAllowance ? '检查授权中...' : `授权 ${token1.symbol}`}
            </button>
          ) : (
            <button
              onClick={poolExists ? addLiquidity : createPoolAndAddLiquidity}
              disabled={!amount0 || !amount1 || hasInsufficientBalance0 || hasInsufficientBalance1 || isPending || isConfirming || isCalculating || isCheckingPool || isCheckingAllowance || !!priceError || !token0 || !token1}
              className={cn(
                "w-full py-4 rounded-lg font-medium text-lg transition-colors",
                !amount0 || !amount1 || hasInsufficientBalance0 || hasInsufficientBalance1 || isPending || isConfirming || isCalculating || isCheckingPool || isCheckingAllowance || !!priceError || !token0 || !token1
                  ? "bg-muted text-muted-foreground cursor-not-allowed"
                  : "bg-primary hover:bg-primary/90 text-primary-foreground"
              )}
            >
              {isPending || isConfirming 
                ? '处理中...' 
                : isCalculating
                ? '计算中...'
                : isCheckingPool
                ? '检查池子中...'
                : isCheckingAllowance
                ? '检查授权中...'
                : poolExists 
                ? '添加流动性' 
                : '创建池子并添加流动性'}
            </button>
          )}
        </>
      )}
    </>
  )

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="bg-card border border-border rounded-2xl shadow-lg p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-card-foreground">添加流动性</h2>
          {step !== 'select' && (
            <button
              onClick={backToSelect}
              className="text-sm text-primary hover:text-primary/80"
            >
              重新选择
            </button>
          )}
        </div>

        {/* Transaction Status */}
        {step === 'addLiquidity' && <TransactionStatus />}

        {/* Wallet Status */}
        {isConnected && address && step === 'addLiquidity' && (
          <div className="mb-4 p-3 bg-primary/10 rounded-lg">
            <div className="text-sm text-primary">
              已连接: {shortenAddress(address)}
            </div>
          </div>
        )}

        {/* 根据步骤渲染不同界面 */}
        {step === 'select' && renderSelectStep()}
        {step === 'searching' && (
          <div className="text-center py-8">
            <Clock className="w-8 h-8 animate-spin text-primary mx-auto mb-4" />
            <p className="text-muted-foreground">正在搜索资金池...</p>
          </div>
        )}
        {step === 'found' && renderFoundStep()}
        {step === 'notFound' && renderNotFoundStep()}
        {step === 'addLiquidity' && renderAddLiquidityStep()}
      </div>
    </div>
  )
}

