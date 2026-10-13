// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

contract TestTokenPermit is ERC20, ERC20Permit {
    constructor() ERC20("TestTokenPermit", "TKP") ERC20Permit("TestTokenPermit") {}

    function mint(address recipient, uint256 quantity) external {
        _mint(recipient, quantity);
    }
}
