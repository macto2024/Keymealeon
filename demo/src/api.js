// Stands in for the storefront API. Prices come back pre-formatted for display,
// which is ordinary for a real endpoint and is exactly what the cart math assumes away.
export async function fetchCart() {
  return {
    currency: 'USD',
    items: [
      { sku: 'KM6-BLK', name: 'Keymaeleon 6', price: '$149.00', quantity: 1 },
      { sku: 'CAP-SET', name: 'Spare keycaps', price: '$19.99', quantity: 2 },
    ],
  };
}
