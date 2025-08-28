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
        uint256 temp = available;
        uint256 count;

        // First pass: count payable queued redemptions while skipping those too large.
        for (uint256 i = q.head; i < len; i++) {
            uint256 req = q.redeemList[i].amount;
            if (req <= temp) {
                temp -= req;
                count++;
            }
        }

        bool considerNew = redeemer != address(0) && amount > 0;
        bool newPayable = considerNew && amount <= temp;
        uint256 total = count + (newPayable ? 1 : 0);
        payables = new Redeem[](total);

        // Second pass: collect payable redemptions and compact queue.
        temp = available;
        uint256 write = q.head;
        uint256 pIndex;
        for (uint256 i = q.head; i < len; i++) {
            Redeem memory r = q.redeemList[i];
            if (r.amount <= temp) {
                temp -= r.amount;
                payables[pIndex++] = r;
            } else {
                if (write != i) {
                    q.redeemList[write] = r;
                }
                write++;
            }
        }

        // Remove processed entries from the end of the array.
        while (q.redeemList.length > write) {
            q.redeemList.pop();
        }

        // Compact storage occasionally to avoid growth.
        if (q.head > 0 && q.head * 2 > q.redeemList.length) {
            uint256 newLen = q.redeemList.length - q.head;
            for (uint256 k = 0; k < newLen; k++) {
                q.redeemList[k] = q.redeemList[q.head + k];
            }
            for (uint256 k = 0; k < q.head; k++) {
                q.redeemList.pop();
            }
            q.head = 0;
        }

        // Handle new redemption if any.
        if (considerNew) {
            if (newPayable) {
                payables[pIndex] = Redeem({redeemer: redeemer, amount: amount});
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

