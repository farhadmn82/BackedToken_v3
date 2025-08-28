// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Library implementing a redemption queue using a mapping based
/// structure with head and tail indices. Processing is performed in batches
/// to cap gas usage per transaction.
library RedemptionQueue {
    struct Redeem {
        address redeemer;
        uint256 amount;
    }

    struct Queue {
        mapping(uint256 => Redeem) items;
        uint256 head;
        uint256 tail;
    }

    /// @notice Process queued redemptions and optionally a new request.
    /// @param q Queue of pending redemptions.
    /// @param redeemer Address requesting redemption. Zero address to skip.
    /// @param amount Amount requested for redemption.
    /// @param available Stablecoin liquidity available for payouts.
    /// @param maxToProcess Maximum number of queued entries to process.
    /// @return payables Redemptions that should be paid out now.
    function process(
        Queue storage q,
        address redeemer,
        uint256 amount,
        uint256 available,
        uint256 maxToProcess
    ) internal returns (Redeem[] memory payables) {
        uint256 remaining = available;
        uint256 processed = 0;
        uint256 idx = q.head;

        // Iterate through the queue up to the batch limit while funds allow.
        while (
            processed < maxToProcess &&
            idx < q.tail &&
            q.items[idx].amount <= remaining
        ) {
            remaining -= q.items[idx].amount;
            idx++;
            processed++;
        }

        bool considerNew = redeemer != address(0) && amount > 0;
        bool newPayable =
            considerNew &&
            amount <= remaining &&
            processed < maxToProcess;

        uint256 payoutCount = processed + (newPayable ? 1 : 0);
        payables = new Redeem[](payoutCount);

        // Collect payable redemptions and clear them from storage.
        for (uint256 i = 0; i < processed; i++) {
            Redeem storage r = q.items[q.head];
            payables[i] = r;
            delete q.items[q.head];
            q.head++;
        }

        // Handle new redemption request.
        if (considerNew) {
            if (newPayable) {
                payables[processed] = Redeem({redeemer: redeemer, amount: amount});
            } else {
                q.items[q.tail] = Redeem({redeemer: redeemer, amount: amount});
                q.tail++;
            }
        }
    }

    /// @return Number of queued redemptions.
    function length(Queue storage q) internal view returns (uint256) {
        return q.tail - q.head;
    }

    /// @notice Access a queued redemption by index.
    function get(Queue storage q, uint256 index) internal view returns (Redeem storage) {
        return q.items[q.head + index];
    }
}

