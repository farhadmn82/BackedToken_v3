// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Simple ERC20 token used as mock stablecoin in tests.
contract StablecoinMock is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    /// @notice Mint `amount` tokens to `to`.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
