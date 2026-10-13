/// SPDX-License-Identifier: GPL-2.0-or-later // SPDX (软件包数据交换协议-许可证标识符) License (许可证) Identifier (标识符) : GPL-2.0-or-later (GNU通用公共许可证 2.0或更高版本)
pragma solidity ^0.8.24; // pragma (编译器指令) solidity (以太坊智能合约语言) ^0.8.24 (编译器版本在0.8.24及以上)
pragma abicoder v2; // pragma (编译器指令) abicoder v2 (使用第2版ABI编码器/解码器，支持结构体与嵌套数组等复杂类型)

import "./IPool.sol"; // import (导入) "./IPool.sol" (同目录下的代币池接口文件 IPool.sol)

interface ISwapRouter is ISwapCallback { // interface (接口声明) ISwapRouter (交换路由器接口) is (继承自) ISwapCallback (交换回调接口) {
    event Swap( // event (事件声明) Swap (兑换/交换事件) (
        address indexed sender, // address (地址类型) indexed (添加索引以便于检索) sender (发送者/发起人),
        bool zeroForOne, // bool (布尔类型) zeroForOne (是否为代币0兑换成代币1，true表示用Token0兑换Token1，false表示用Token1兑换Token0),
        uint256 amountIn, // uint256 (256位无符号整型) amountIn (输入代币数量/存入的金额),
        uint256 amountInRemaining, // uint256 (256位无符号整型) amountInRemaining (剩余的输入代币数量/未完成交换的存入金额),
        uint256 amountOut // uint256 (256位无符号整型) amountOut (输出代币数量/兑换得到的金额)
    ); // ) (事件参数结束)

    struct ExactInputParams { // struct (结构体声明) ExactInputParams (精准输入参数结构体/指定确切输入数额的参数) {
        address tokenIn; // address (地址类型) tokenIn (输入代币/存入代币的合约地址);
        address tokenOut; // address (地址类型) tokenOut (输出代币/兑换出代币的合约地址);
        uint32[] indexPath; // uint32[] (32位无符号整型数组) indexPath (路径索引/多路径兑换的路由路径索引数组);
        address recipient; // address (地址类型) recipient (接收者/兑换后代币的接收地址);
        uint256 deadline; // uint256 (256位无符号整型) deadline (截止期限/交易的最迟执行时间戳，超时则交易失败);
        uint256 amountIn; // uint256 (256位无符号整型) amountIn (确切的输入代币数量);
        uint256 amountOutMinimum; // uint256 (256位无符号整型) amountOutMinimum (输出代币的最小值/滑点保护，低于此值则交易回滚); // 最小输出数量
        uint160 sqrtPriceLimitX96; // uint160 (160位无符号整型) sqrtPriceLimitX96 (平方根价格限制/兑换过程中的最大或最小价格边界限制，96位定点数);
    } // } (结构体定义结束)

    function exactInput( // function (函数声明) exactInput (精准输入兑换函数/根据确切输入数量兑换输出代币) (
        ExactInputParams calldata params // ExactInputParams (精准输入参数结构体) calldata (只读调用数据位置) params (参数变量名)
    ) external payable returns (uint256 amountOut); // ) external (外部可调用) payable (可接收原生代币ETH) returns (返回) (uint256 (无符号整型) amountOut (最终兑换出的代币数量));

    struct ExactOutputParams { // struct (结构体声明) ExactOutputParams (精准输出参数结构体/指定确切目标输出数额的参数) {
        address tokenIn; // address (地址类型) tokenIn (输入代币/存入代币的合约地址);
        address tokenOut; // address (地址类型) tokenOut (输出代币/兑换出代币的合约地址);
        uint32[] indexPath; // uint32[] (32位无符号整型数组) indexPath (路径索引/多路径兑换的路由路径索引数组);
        address recipient; // address (地址类型) recipient (接收者/兑换后代币的接收地址);
        uint256 deadline; // uint256 (256位无符号整型) deadline (截止期限/交易的最迟执行时间戳，超时则交易失败);
        uint256 amountOut; // uint256 (256位无符号整型) amountOut (确切的目标输出代币数量);
        uint256 amountInMaximum; // uint256 (256位无符号整型) amountInMaximum (允许的最大输入代币数量/滑点保护，高于此值则交易回滚);
        uint160 sqrtPriceLimitX96; // uint160 (160位无符号整型) sqrtPriceLimitX96 (平方根价格限制/兑换过程中的最大或最小价格边界限制，96位定点数);
    } // } (结构体定义结束)

    function exactOutput( // function (函数声明) exactOutput (精准输出兑换函数/根据确切目标输出数量计算并存入代币) (
        ExactOutputParams calldata params // ExactOutputParams (精准输出参数结构体) calldata (只读调用数据位置) params (参数变量名)
    ) external payable returns (uint256 amountIn); // ) external (外部可调用) payable (可接收原生代币ETH) returns (返回) (uint256 (无符号整型) amountIn (最终实际支付消耗的输入代币数量));

    struct QuoteExactInputParams { // struct (结构体声明) QuoteExactInputParams (精准输入估算参数结构体/用于估算精准输入能兑换出多少代币的参数) {
        address tokenIn; // address (地址类型) tokenIn (输入代币/存入代币的合约地址);
        address tokenOut; // address (地址类型) tokenOut (输出代币/兑换出代币的合约地址);
        uint32[] indexPath; // uint32[] (32位无符号整型数组) indexPath (路径索引/多路径兑换的路由路径索引数组);
        uint256 amountIn; // uint256 (256位无符号整型) amountIn (预期的输入代币数量);
        uint160 sqrtPriceLimitX96; // uint160 (160位无符号整型) sqrtPriceLimitX96 (平方根价格限制/兑换过程中的价格边界限制);
    } // } (结构体定义结束)

    function quoteExactInput( // function (函数声明) quoteExactInput (精准输入估算函数/模拟估算能兑换出多少代币) (
        QuoteExactInputParams calldata params // QuoteExactInputParams (精准输入估算参数结构体) calldata (只读数据位置) params (参数变量名)
    ) external returns (uint256 amountOut); // ) external (外部可调用) returns (返回) (uint256 (无符号整型) amountOut (估算出的可兑换出的代币数量));

    struct QuoteExactOutputParams { // struct (结构体声明) QuoteExactOutputParams (精准输出估算参数结构体/用于估算实现精准输出需要多少输入代币的参数) {
        address tokenIn; // address (地址类型) tokenIn (输入代币/存入代币的合约地址);
        address tokenOut; // address (地址类型) tokenOut (输出代币/兑换出代币的合约地址);
        uint32[] indexPath; // uint32[] (32位无符号整型数组) indexPath (路径索引/多路径兑换的路由路径索引数组);
        uint256 amountOut; // uint256 (256位无符号整型) amountOut (预期的目标输出代币数量);
        uint160 sqrtPriceLimitX96; // uint160 (160位无符号整型) sqrtPriceLimitX96 (平方根价格限制/兑换过程中的价格边界限制);
    } // } (结构体定义结束)

    function quoteExactOutput( // function (函数声明) quoteExactOutput (精准输出估算函数/模拟估算需要支付多少代币) (
        QuoteExactOutputParams calldata params // QuoteExactOutputParams (精准输出估算参数结构体) calldata (只读数据位置) params (参数变量名)
    ) external returns (uint256 amountIn); // ) external (外部可调用) returns (返回) (uint256 (无符号整型) amountIn (估算出的需要支付的输入代币数量));

    /// @notice 批量调用 Router 自身方法（Uniswap 风格）：按顺序 delegatecall 执行 data 中的每一项调用数据。
    // @notice (接口文档提示：向用户说明此方法的作用) 批量调用 Router 自身方法（Uniswap 风格）：按顺序 delegatecall (委托调用) 执行 data (数据) 中的每一项调用数据。
    /// @dev 该方法为 payable，可与需要 ETH/value 的子调用一起使用；返回每个子调用的原始返回值 bytes。
    // @dev (开发实现提示) 该方法为 payable (可接收ETH)，可与需要 ETH/value (币值) 的子调用一起使用；返回每个子调用的原始返回值 bytes (字节数组)。
    function multicall( // function (函数声明) multicall (多重调用/批量打包调用函数) (
        bytes[] calldata data // bytes[] (字节数组的数组) calldata (只读数据位置) data (要批量调用的编码数据列表)
    ) external payable returns (bytes[] memory results); // ) external (外部可调用) payable (可接收ETH) returns (返回) (bytes[] (字节数组的数组) memory (内存数据位置) results (每次调用的返回结果集合));

    /// @notice 将本次调用携带的 ETH 全部包装成 WETH9，WETH 保留在 Router 中，便于后续 multicall 子调用使用。
    // @notice (接口文档提示) 将本次调用携带 of ETH 全部包装成 WETH9 (封装以太坊)，WETH (封装以太坊) 保留在 Router (路由器) 中，便于后续 multicall (多重调用) 子调用使用。
    function wrapETH() external payable; // function (函数声明) wrapETH (包装ETH函数/存入ETH转为WETH9) () external (外部可调用) payable (可接收ETH);

    /// @notice 将 Router 持有的全部 WETH9 解包为 ETH 并转给 recipient。
    // @notice (接口文档提示) 将 Router (路由器) 持有的全部 WETH9 (封装以太坊) 解包为 ETH 并转给 recipient (接收者)。
    function unwrapWETH9( // function (函数声明) unwrapWETH9 (解包WETH9函数) (
        uint256 amountMinimum, // uint256 (无符号整型) amountMinimum (解包并转出的最小金额，滑点保护);
        address recipient // address (地址类型) recipient (解包后ETH的接收地址)
    ) external payable; // ) external (外部可调用) payable (可接收ETH);

    /// @notice 将 Router 当前持有的 ETH 退回给调用者。
    // @notice (接口文档提示) 将 Router (路由器) 当前持有的 ETH 退回给调用者。
    function refundETH() external payable; // function (函数声明) refundETH (退回ETH函数/将未用完的ETH退给调用者) () external (外部可调用) payable (可接收ETH);

    /// @notice 将 Router 持有的指定 ERC20 全部转给 recipient。
    // @notice (接口文档提示) 将 Router (路由器) 持有的指定 ERC20 (以太坊代币标准) 全部转给 recipient (接收者)。
    function sweepToken( // function (函数声明) sweepToken (清扫/归集代币函数) (
        address token, // address (地址类型) token (需要清扫的代币合约地址);
        uint256 amountMinimum, // uint256 (无符号整型) amountMinimum (清扫转出的最小金额);
        address recipient // address (地址类型) recipient (清扫后代币的接收地址)
    ) external payable; // ) external (外部可调用) payable (可接收ETH);

    /// @notice 使用 EIP-2612 permit 为 Router 授权，无需单独发 approve 交易。
    // @notice (接口文档提示) 使用 EIP-2612 permit (许可/授权签名) 为 Router (路由器) 授权，无需单独发 approve (常规授权) 交易。
    function selfPermit( // function (函数声明) selfPermit (自主授权函数) (
        address token, // address (地址类型) token (要进行授权的代币合约地址);
        uint256 value, // uint256 (256位无符号整型) value (要授权的代币额度数量);
        uint256 deadline, // uint256 (256位无符号整型) deadline (授权签名的截止时间戳);
        uint8 v, // uint8 (8位无符号整型) v (ECDSA签名的恢复标识分量v);
        bytes32 r, // bytes32 (32字节数组类型) r (ECDSA签名的r分量);
        bytes32 s // bytes32 (32字节数组类型) s (ECDSA签名的s分量)
    ) external payable; // ) external (外部可调用) payable (可接收ETH);

    /// @notice 当 allowance 不足时才执行 permit，避免重复签名/调用。
    // @notice (接口文档提示) 当 allowance (授信额度) 不足时才执行 permit (签名授权)，避免重复签名/调用。
    function selfPermitIfNecessary( // function (函数声明) selfPermitIfNecessary (必要时自主授权函数) (
        address token, // address (地址类型) token (要进行授权的代币合约地址);
        uint256 value, // uint256 (256位无符号整型) value (期望拥有的代币额度数量);
        uint256 deadline, // uint256 (256位无符号整型) deadline (授权签名的截止时间戳);
        uint8 v, // uint8 (8位无符号整型) v (ECDSA签名的v分量);
        bytes32 r, // bytes32 (32字节数组类型) r (ECDSA签名的r分量);
        bytes32 s // bytes32 (32字节数组类型) s (ECDSA签名的s分量)
    ) external payable; // ) external (外部可调用) payable (可接收ETH);
} // } (接口ISwapRouter声明结束)
