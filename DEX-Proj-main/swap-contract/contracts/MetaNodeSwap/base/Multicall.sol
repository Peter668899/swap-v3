// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @title Multicall
/// @notice 提供同合约上下文的批量调用能力（Uniswap 风格）。
/// @dev 通过 delegatecall(address(this), data[i]) 执行；失败时原样透传 revert data。
abstract contract Multicall {
    /// @notice 批量调用多个合约方法（原子执行）。
    /// @dev 每个子调用通过 delegatecall 在当前合约上下文中执行，保持 msg.sender 和 msg.value 一致。
    ///      如果某个子调用失败，整个交易回滚并透传该调用的 revert 原因。
    /// @param data 多个调用的 calldata 数组
    /// @return results 每个调用的返回结果数组
    function multicall(
        bytes[] calldata data
    ) public payable virtual returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool success, bytes memory result) = address(this).delegatecall(
                data[i]
            );
            if (!success) {
                assembly {
                    revert(add(result, 0x20), mload(result))
                }
            }
            results[i] = result;
        }
    }
}
