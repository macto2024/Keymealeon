// Cart arithmetic.
//
// BUG (covered by no test): the API returns `price` as a display string such as
// "$19.99". Multiplying that by a quantity yields NaN, so the total is NaN.
//
// Every test in test/cart.test.js builds its own items with numeric prices, so the
// suite is green while the running page is broken. That gap is the point of the demo.
export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function lineCount(items) {
  return items.reduce((count, item) => count + item.quantity, 0);
}
