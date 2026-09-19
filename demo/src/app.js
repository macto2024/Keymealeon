import { fetchCart } from './api.js';
import { cartTotal, lineCount } from './cart.js';
import { formatMoney } from './format.js';
import { reportError, reportHealthy } from './report.js';

const $ = id => document.getElementById(id);

async function render() {
  const cart = await fetchCart();

  $('lines').innerHTML = '';
  for (const item of cart.items) {
    const row = document.createElement('div');
    row.className = 'line';
    row.innerHTML = '<span class="name"></span><span class="qty"></span><span class="price"></span>';
    row.querySelector('.name').textContent = item.name;
    row.querySelector('.qty').textContent = `x${item.quantity}`;
    // The API already returns a display string, so line items look correct.
    row.querySelector('.price').textContent = item.price;
    $('lines').append(row);
  }

  $('count').textContent = `${lineCount(cart.items)} items`;

  const total = cartTotal(cart.items);
  $('total').textContent = formatMoney(total);

  // The page can see something no test asserts and no agent reads: the rendered total.
  if (!Number.isFinite(total)) {
    $('total').classList.add('broken');
    reportError(`TypeError: cart total is not a number — API returned price as "${cart.items[0].price}"`);
  } else {
    $('total').classList.remove('broken');
    reportHealthy();
  }
}

render();
