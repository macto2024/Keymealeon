import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../src/format.js';

test('formats whole amounts with two decimal places', () => {
  assert.equal(formatMoney(20), '$20.00');
});

test('rounds to the nearest cent', () => {
  assert.equal(formatMoney(19.994), '$19.99');
});

test('keeps a trailing zero in the cents column', () => {
  assert.equal(formatMoney(149.5), '$149.50');
});
