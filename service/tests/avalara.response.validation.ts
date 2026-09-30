import { TransactionLineModel } from 'avatax/lib/models/TransactionLineModel';
import { TransactionModel } from 'avatax/lib/models/TransactionModel';
import { expect } from '@jest/globals';

export const expectAvaTaxReturn = (taxResponse: TransactionModel) => {
  expect(taxResponse.code).toEqual('0');
  expect(taxResponse.date).toEqual(new Date().toISOString().substring(0, 10));
  expect(taxResponse.status).toEqual('Temporary');
  expect(taxResponse.type).toEqual('SalesOrder');
  expect(taxResponse.currencyCode).toEqual('USD');
  expect(taxResponse.entityUseCode).toEqual('B');
  expect(taxResponse.customerCode).toEqual('0');
  expect(taxResponse.totalAmount).toEqual(707);
  expect(taxResponse.totalTax).toEqual(51.27);
  expect(taxResponse.lines).toHaveLength(3);
  const item: TransactionLineModel =
    taxResponse.lines?.find((line) => line.itemCode === 'sku123') ??
    ({} as TransactionLineModel);
  const shipping: TransactionLineModel =
    taxResponse.lines?.find((line) => line.itemCode === 'Shipping') ??
    ({} as TransactionLineModel);
  expect(item.itemCode).toEqual('sku123');
  expect(item.quantity).toEqual(2);
  expect(item.lineAmount).toEqual(655);
  expect(item.taxCode).toEqual('PS081282');
  expect(item.tax).toEqual(47.49);
  expect(item.taxIncluded).toEqual(false);
  expect(shipping.itemCode).toEqual('Shipping');
  expect(shipping.quantity).toEqual(1);
  expect(shipping.lineAmount).toEqual(10);
  expect(shipping.taxCode).toEqual('PC030000');
  expect(shipping.tax).toEqual(0.73);
  expect(shipping.taxIncluded).toEqual(false);
  expect(taxResponse.addresses).toHaveLength(2);
  expect(
    taxResponse.addresses?.find((address) => address.line1 === '505 Beasley St')
  ).toBeDefined();
  expect(
    taxResponse.addresses?.find((address) => address.line1 === '2000 Main St')
  ).toBeDefined();
};

// Rates, not amounts: the connector runs the cart in `External` tax mode so
// commercetools computes the tax itself and can apportion a `totalPrice` cart
// discount. See the note in `postprocess.get.tax.ts`. There is deliberately no
// `setCartTotalTax` -- that action only exists in `ExternalAmount`.
export const actions = {
  actions: [
    { action: 'changeTaxMode', taxMode: 'External' },
    {
      action: 'setLineItemTaxRate',
      lineItemId: 'id123',
      externalTaxRate: { name: 'avaTaxRate', amount: 0.0725, country: 'US' },
    },
    {
      action: 'setCustomLineItemTaxRate',
      customLineItemId: '641649e5-2337-4871-90ab-164fd3e919b3',
      externalTaxRate: {
        name: 'avaTaxRate',
        amount: 0.0725,
        country: 'US',
      },
    },
    {
      action: 'setShippingMethodTaxRate',
      externalTaxRate: { name: 'avaTaxRate', amount: 0.0725, country: 'US' },
    },
    {
      action: 'setCustomField',
      name: 'avalaraHash',
      value: 'ae6a3c3af8b7caeb6ff3e397ea552afd',
    },
  ],
};
