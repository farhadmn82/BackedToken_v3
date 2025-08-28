// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library RedemptionQueue {
    struct Redeem {
        address redeemer;
        uint256 amount;
    }

    struct Queue {
        Redeem[] redeemList;
        uint256 head;
    }

    /// @notice Process pending redemptions given available liquidity and a new request.
    /// @param q Queue of pending redemptions.
    /// @param redeemer Address requesting redemption.
    /// @param amount Amount requested for redemption.
    /// @param available Available liquidity for payouts.
    /// @return payables Redemptions that can be paid out now (FIFO).
    function process(
        Queue storage q,
        address redeemer,
        uint256 amount,
        uint256 available
    ) internal returns (Redeem[] memory payables) {
        uint256 len = q.redeemList.length;
        uint256 i = q.head;
        uint256 temp = available;

        // Determine how many queued redemptions are payable.
        while (i < len && temp >= q.redeemList[i].amount) {
            temp -= q.redeemList[i].amount;
            i++;
        }

        bool considerNew = redeemer != address(0) && amount > 0;
        bool newPayable = considerNew && amount <= temp;
        uint256 processed = i - q.head;
        uint256 total = processed + (newPayable ? 1 : 0);
        payables = new Redeem[](total);

        // Collect payable queued redemptions.
        for (uint256 j = 0; j < processed; j++) {
            payables[j] = q.redeemList[q.head + j];
            delete q.redeemList[q.head + j];
        }
        q.head = i;

        // Compact storage occasionally to avoid growth.
        if (q.head > 0 && q.head * 2 > q.redeemList.length) {
            for (uint256 k = q.head; k < q.redeemList.length; k++) {
                q.redeemList[k - q.head] = q.redeemList[k];
            }
            for (uint256 k = 0; k < q.head; k++) {
                q.redeemList.pop();
            }
            q.head = 0;
        }

        // Handle new redemption if any.
        if (considerNew) {
            if (newPayable) {
                payables[total - 1] = Redeem({redeemer: redeemer, amount: amount});
            } else {
                q.redeemList.push(Redeem({redeemer: redeemer, amount: amount}));
            }
        }
    }

    function length(Queue storage q) internal view returns (uint256) {
        return q.redeemList.length - q.head;
    }

    function get(Queue storage q, uint256 index) internal view returns (Redeem storage) {
        return q.redeemList[q.head + index];
    }
}

