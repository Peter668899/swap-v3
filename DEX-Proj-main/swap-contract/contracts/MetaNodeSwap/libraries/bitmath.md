```solidity

// 简化理解版：Uniswap V3 如何快速找下一个有流动性的 Tick
contract MockTickBitmap {

    // 核心存储：一个 int16(字位置) => uint256(位图)
    // 每个 uint256 可以存 256 个 tick 的状态：1=有流动性，0=没有
    mapping(int16 => uint256) public tickBitmap;

    // 费率对应的间距，比如 0.3% 池是 60
    int24 public immutable tickSpacing;

    constructor(int24 _tickSpacing) {
        tickSpacing = _tickSpacing;
    }

    // ==============================================
    // 1. 添加流动性时：把某个 tick 标记为“已初始化”
    // ==============================================
    function setTickInitialized(int24 tick) internal {
        // 先把 tick 对齐到合法边界（必须是 tickSpacing 的整数倍）
        int24 normalizedTick = tick / tickSpacing;

        // 拆成：字位置(word) + 位位置(bit)
        // 一个字存 256 位
        int16 wordPos = int16(normalizedTick / 256);
        uint8 bitPos = uint8(normalizedTick % 256);

        // 把对应 bit 设为 1
        tickBitmap[wordPos] |= (1 << bitPos);
    }

    // ==============================================
    // 2. 核心：从当前 tick 出发，找**下一个有流动性的 tick**
    // ==============================================
    function findNextInitializedTick(int24 currentTick, bool zeroForOne) 
        internal view returns (int24 nextTick) 
    {
        int24 normalizedTick = currentTick / tickSpacing;

        // 方向：true=向左找更小，false=向右找更大
        if (zeroForOne) {
            normalizedTick -= 1;
        } else {
            normalizedTick += 1;
        }

        // 循环找：先按字(word)跳，再按位(bit)找
        while (true) {
            int16 wordPos = int16(normalizedTick / 256);
            uint8 bitPos = uint8(normalizedTick % 256);
            uint256 bitmap = tickBitmap[wordPos];

            if (zeroForOne) {
                // 向左：从当前 bit 往低位扫
                uint256 masked = bitmap << (255 - bitPos);
                if (masked != 0) {
                    uint8 firstSet = _getMostSignificantBit(masked);
                    nextTick = (normalizedTick - int24(bitPos - firstSet)) * tickSpacing;
                    return nextTick;
                }
                // 这字没找到，跳到上一个字
                normalizedTick = normalizedTick - int24(bitPos) - 1;
            } else {
                // 向右：从当前 bit 往高位扫
                uint256 masked = bitmap >> bitPos;
                if (masked != 0) {
                    uint8 firstSet = _getLeastSignificantBit(masked);
                    nextTick = (normalizedTick + int24(firstSet)) * tickSpacing;
                    return nextTick;
                }
                // 这字没找到，跳到下一个字
                normalizedTick = normalizedTick + int24(255 - bitPos) + 1;
            }
        }
    }

    // 辅助：找最低位的 1
    function _getLeastSignificantBit(uint256 x) internal pure returns (uint8) {
        return uint8(x & -x); // 位运算 trick
    }

    // 辅助：找最高位的 1
    function _getMostSignificantBit(uint256 x) internal pure returns (uint8) {
        uint8 r;
        while (x > 0) {
            x >>= 1;
            r += 1;
        }
        return r - 1;
    }
}
```