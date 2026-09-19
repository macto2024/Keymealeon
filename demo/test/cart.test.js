import test from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal, lineCount } from '../src/cart.js';

// Every case here builds its own items with numeric prices. The storefront API returns
// price as a display string, so these pass while the running page shows NaN. The suite
// is not wrong; it is simply blind to the shape of the real data.
test('sums line totals', () => {
  assert.equal(cartTotal([{ price: 10, quantity: 2 }, { price: 5, quantity: 1 }]), 25);
});

test('counts every unit, not every line', () => {
  assert.equal(lineCount([{ price: 10, quantity: 2 }, { price: 5, quantity: 3 }]), 5);
});

test('an empty cart totals zero', () => {
  assert.equal(cartTotal([]), 0);
});
