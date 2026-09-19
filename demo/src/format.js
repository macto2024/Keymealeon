// Money formatting for the checkout page.
//
// BUG (caught by test/format.test.js): Math.round returns a Number, so trailing
// zeros are lost — 20 formats as "$20" rather than "$20.00". The fix is toFixed(2).
export function formatMoney(value) {
  return `$${Math.round(value * 100) / 100}`;
}
