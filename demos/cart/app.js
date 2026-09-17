import { calculateCart, FREE_SHIPPING_THRESHOLD_CENTS } from './pricing.js';

let quantity = 1;
const element = (id) => document.getElementById(id);
const money = (cents) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(cents / 100);
function render() {
  const cart = calculateCart(quantity);
  element('quantity').textContent = String(quantity);
  element('bag-count').textContent = String(quantity);
  element('item-count').textContent = `${quantity} ${quantity === 1 ? 'item' : 'items'}`;
  element('subtotal').textContent = money(cart.subtotalCents);
  element('shipping').textContent = cart.shippingCents === 0 ? 'FREE' : money(cart.shippingCents);
  element('shipping').classList.toggle('free', cart.shippingCents === 0);
  element('total').textContent = money(cart.totalCents);
  const remaining = Math.max(0, FREE_SHIPPING_THRESHOLD_CENTS - cart.subtotalCents);
  element('shipping-message').textContent = remaining === 0 ? 'Your order qualifies for free shipping.' : `Add ${money(remaining)} more for free shipping.`;
  element('shipping-progress').value = Math.min(cart.subtotalCents, FREE_SHIPPING_THRESHOLD_CENTS);
  element('decrease').disabled = quantity === 1;
  element('increase').disabled = quantity === 10;
}
element('decrease').addEventListener('click', () => { if (quantity > 1) quantity--; render(); });
element('increase').addEventListener('click', () => { if (quantity < 10) quantity++; render(); });
render();
