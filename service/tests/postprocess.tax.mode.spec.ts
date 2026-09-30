import { postProcessing } from '../src/avalara/requests/postprocess/postprocess.get.tax';
import { fullCart } from './carts';
import { Cart } from '@commercetools/platform-sdk';
import { TransactionModel } from 'avatax/lib/models/TransactionModel';

const address = {
  streetName: '2093 Philadelphia Pike',
  postalCode: '19703',
  city: 'Claymont',
  state: 'DE',
  country: 'US',
};

/* One AvaTax line per thing the cart can be taxed on, at a flat 7.25%. */
const taxResponse = {
  lines: [
    {
      itemCode: 'sku123',
      tax: 4.73,
      details: [{ rate: 0.0725, taxableAmount: 65.25, nonTaxableAmount: 0 }],
    },
    {
      itemCode: 'custom-line-item-key',
      tax: 0.3,
      details: [{ rate: 0.0725, taxableAmount: 42.0, nonTaxableAmount: 0 }],
    },
    {
      itemCode: 'Shipping',
      tax: 0.73,
      details: [{ rate: 0.0725, taxableAmount: 10.0, nonTaxableAmount: 0 }],
    },
  ],
} as unknown as TransactionModel;

const cartWith = (over: Record<string, unknown>) =>
  ({ ...fullCart(address as never), ...over } as unknown as Cart);

const find = (actions: Array<{ action: string }>, action: string) =>
  actions.filter((a) => a.action === action);

/*
The connector picks its tax mode per cart. `ExternalAmount` is the default and
keeps AvaTax authoritative for the exact cent; a cart carrying an order-level
discount switches to `External` because commercetools deducts such a discount
from the cart gross twice in `ExternalAmount`, producing a negative tax and an
undercharge.
*/
describe('postProcessing tax mode', () => {
  describe('cart with no order-level discount', () => {
    const actions = postProcessing(
      cartWith({ discountOnTotalPrice: undefined }),
      taxResponse
    ) as Array<{ action: string; [k: string]: unknown }>;

    it('stays in ExternalAmount', () => {
      expect(find(actions, 'changeTaxMode')[0]).toEqual({
        action: 'changeTaxMode',
        taxMode: 'ExternalAmount',
      });
    });

    it("states AvaTax's exact amounts, not rates", () => {
      expect(find(actions, 'setLineItemTaxAmount')).toHaveLength(1);
      expect(find(actions, 'setLineItemTaxRate')).toHaveLength(0);
    });

    it('states the cart total, which commercetools honours here', () => {
      expect(find(actions, 'setCartTotalTax')).toHaveLength(1);
    });
  });

  describe('cart with an order-level (totalPrice) discount', () => {
    const actions = postProcessing(
      cartWith({
        discountOnTotalPrice: {
          discountedAmount: { centAmount: 2550, currencyCode: 'USD' },
          discountedNetAmount: { centAmount: 2550, currencyCode: 'USD' },
          discountedGrossAmount: { centAmount: 2367, currencyCode: 'USD' },
          includedDiscounts: [],
        },
      }),
      taxResponse
    ) as Array<{ action: string; [k: string]: unknown }>;

    it('switches to External so commercetools emits tax portions', () => {
      expect(find(actions, 'changeTaxMode')[0]).toEqual({
        action: 'changeTaxMode',
        taxMode: 'External',
      });
    });

    it('sends rates for every taxable element', () => {
      expect(find(actions, 'setLineItemTaxRate')).toHaveLength(1);
      expect(find(actions, 'setCustomLineItemTaxRate')).toHaveLength(1);
      expect(find(actions, 'setShippingMethodTaxRate')).toHaveLength(1);
      expect(find(actions, 'setLineItemTaxAmount')).toHaveLength(0);
    });

    it('carries the AvaTax rate through unchanged', () => {
      expect(find(actions, 'setLineItemTaxRate')[0]).toMatchObject({
        externalTaxRate: { name: 'avaTaxRate', amount: 0.0725, country: 'US' },
      });
    });

    // The action only exists in ExternalAmount, and commercetools discards
    // externalTotalGross anyway whenever discountOnTotalPrice is present.
    it('does not state a cart total', () => {
      expect(find(actions, 'setCartTotalTax')).toHaveLength(0);
    });
  });
});
