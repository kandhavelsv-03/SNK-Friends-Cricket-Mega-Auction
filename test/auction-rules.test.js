'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM_CONFIG, effectiveOverseas, validateSquadAddition, calculateTradePurses } = require('../lib/auction-rules');

test('SNK auction seeds exactly 14 teams with the configured purses', () => {
  assert.equal(TEAM_CONFIG.length, 14);
  assert.deepEqual(TEAM_CONFIG.find(([code]) => code === 'TG'), ['TG', 87]);
  assert.deepEqual(TEAM_CONFIG.find(([code]) => code === '7SV'), ['7SV', 12]);
});

test('Associate players 1 and 2 use dedicated slots; player 3 onward counts as Overseas', () => {
  assert.equal(effectiveOverseas({ Indian: 0, Overseas: 4, Associate: 2 }), 4);
  assert.equal(effectiveOverseas({ Indian: 0, Overseas: 4, Associate: 3 }), 5);
  assert.equal(effectiveOverseas({ Indian: 0, Overseas: 4, Associate: 11 }), 13);
});

test('squad addition enforces category caps and mandatory squad reserve', () => {
  assert.throws(() => validateSquadAddition({ Indian: 9, Overseas: 0, Associate: 0 }, 90, 0.5, 'Indian'), /Indian maximum/);
  assert.throws(() => validateSquadAddition({ Indian: 8, Overseas: 9, Associate: 2 }, 90, 0.5, 'Associate'), /Effective Overseas maximum/);
  assert.throws(() => validateSquadAddition({ Indian: 7, Overseas: 7, Associate: 1 }, 0.9, 0.5, 'Indian'), /mandatory squad slots/);
});

test('trade debits buyer purse and credits seller purse by the same amount', () => {
  assert.deepEqual(calculateTradePurses(50, 25, 7.5), {
    buyer_remaining_purse: 42.5,
    seller_remaining_purse: 32.5,
    buyer_purse_deducted: 7.5,
    seller_purse_credited: 7.5
  });
  assert.throws(() => calculateTradePurses(5, 25, 7), /not have enough purse/);
});
