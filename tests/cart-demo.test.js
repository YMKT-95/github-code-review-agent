import { describe, expect, it } from 'vitest';
import { calculateCart } from '../demos/cart/pricing.js';

describe('cart demo shipping contract', () => {
  it('charges $5 shipping for a $30 order', () => {
    expect(calculateCart(1)).toEqual({ subtotalCents: 3000, shippingCents: 500, totalCents: 3500 });
  });
  it('ships a $60 order free even though each item costs less than $50', () => {
    expect(calculateCart(2)).toEqual({ subtotalCents: 6000, shippingCents: 0, totalCents: 6000 });
  });
  it('keeps larger orders eligible for free shipping', () => {
    expect(calculateCart(10)).toEqual({ subtotalCents: 30000, shippingCents: 0, totalCents: 30000 });
  });
  it.each([0, -1, 1.5, 11, NaN, Infinity, '2', null])('rejects invalid quantity %s', (quantity) => {
    expect(() => calculateCart(quantity)).toThrow(RangeError);
  });
});
