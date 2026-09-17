export const UNIT_PRICE_CENTS = 3000;
export const FREE_SHIPPING_THRESHOLD_CENTS = 5000;
export const SHIPPING_FEE_CENTS = 500;

/** All amounts are NZD cents. Free shipping applies to the order subtotal. */
export function calculateCart(quantity) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new RangeError('Quantity must be a whole number between 1 and 10.');
  }
  const subtotalCents = UNIT_PRICE_CENTS * quantity;
  const shippingCents = subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : SHIPPING_FEE_CENTS;
  return { subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}
