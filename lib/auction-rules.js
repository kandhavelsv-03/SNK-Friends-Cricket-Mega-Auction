'use strict';

const TEAM_CONFIG = [
  ['KCG', 90], ['ARC', 90], ['DCS', 90], ['VTK', 90], ['SS', 90], ['FCK', 90],
  ['TG', 90], ['BBC', 90], ['AKS', 90], ['KD2', 90], ['BR', 90], ['CC', 90],
  ['RH', 90], ['7SV', 90]
];

const money = value => Number(Number(value).toFixed(2));
const effectiveOverseas = counts => counts.Overseas + Math.max(0, counts.Associate - 2);

function validateSquadAddition(counts, remainingPurse, amount, category) {
  const amt = money(amount);
  if (!Number.isFinite(amt) || amt < 0) throw new Error('Invalid amount');
  if (!['Indian', 'Overseas', 'Associate'].includes(category)) throw new Error('Invalid player category');
  if (Number(remainingPurse) + 0.0001 < amt) throw new Error('Insufficient purse');
  const total = counts.Indian + counts.Overseas + counts.Associate;
  if (total >= 20) throw new Error('Maximum squad size is 20');
  const next = { ...counts, [category]: counts[category] + 1 };
  const nextEff = effectiveOverseas(next);
  if (next.Indian > 9) throw new Error('Indian maximum is 9');
  if (nextEff > 9) throw new Error('Effective Overseas maximum is 9');
  if (next.Associate > 11) throw new Error('Maximum Associate player count is 11 (2 dedicated + 9 overseas slots)');
  const totalAfter = total + 1;
  const slotsAfter = Math.max(0, 17 - totalAfter);
  const missing = Math.max(0, 8 - next.Indian) + Math.max(0, 1 - next.Associate) + Math.max(0, 8 - nextEff);
  if (missing > slotsAfter) throw new Error('This purchase makes the minimum category requirements impossible');
  const reserve = Math.max(0, slotsAfter) * 0.5;
  if (Number(remainingPurse) - amt + 0.0001 < reserve) {
    throw new Error(`Keep at least ₹${reserve.toFixed(2)} Cr reserved for mandatory squad slots`);
  }
  return { next, total: totalAfter, effective_overseas: nextEff, reserve };
}

// Trade accounting rule: debit the buyer and credit the seller by the same trade amount.
function calculateTradePurses(buyerRemaining, sellerRemaining, amount) {
  const tradeAmount = money(amount);
  if (!Number.isFinite(tradeAmount) || tradeAmount <= 0) throw new Error('Enter a valid trade amount greater than zero');
  if (Number(buyerRemaining) < tradeAmount) throw new Error('Buyer team does not have enough purse');
  return {
    buyer_remaining_purse: money(Number(buyerRemaining) - tradeAmount),
    seller_remaining_purse: money(Number(sellerRemaining) + tradeAmount),
    buyer_purse_deducted: tradeAmount,
    seller_purse_credited: tradeAmount
  };
}

module.exports = { TEAM_CONFIG, money, effectiveOverseas, validateSquadAddition, calculateTradePurses };
