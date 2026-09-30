import { Cart, UpdateAction } from '@commercetools/platform-sdk';
import { TransactionModel } from 'avatax/lib/models/TransactionModel';
import { hashCart } from '../../../utils/hash.utils';
import { TransactionLineDetailModel } from 'avatax/lib/models/TransactionLineDetailModel';

export function postProcessing(
  cart: Cart,
  taxResponse: TransactionModel
): Array<UpdateAction> {
  const actions = [];

  /*
  `External`, not `ExternalAmount`.

  In `ExternalAmount` commercetools stores the gross figures we hand it and does
  no tax arithmetic of its own, so it emits no `taxedPrice.taxPortions`. A cart
  discount targeting `totalPrice` then has nothing to be apportioned across, and
  commercetools deducts it from the cart gross TWICE -- once inside
  `cart.totalPrice`, and again as `discountOnTotalPrice.discountedGrossAmount`.
  The cart's gross lands below its net, `totalTax` goes negative, and the shopper
  is charged roughly the whole tax short. `setCartTotalTax` cannot correct it:
  commercetools discards `externalTotalGross` entirely whenever
  `discountOnTotalPrice` is present (verified against a live project -- a probe
  value of 99999 was honoured on an undiscounted cart and ignored on a discounted
  one).

  In `External` we supply the RATE and commercetools computes the amounts. It
  then emits tax portions, apportions the discount correctly, and every cart
  discount target works. The trade-off is that commercetools recalculates from
  the rate using the cart's `taxRoundingMode` rather than storing AvaTax's exact
  amount, so a figure can differ from the AvaTax quote by a cent.
  */
  if (cart?.taxMode !== 'External') {
    actions.push({ action: 'changeTaxMode', taxMode: 'External' });
  }

  const rate = (
    rateSummaryElements: TransactionLineDetailModel[] | undefined
  ) => {
    let rate = 0;

    rateSummaryElements?.forEach((element) => {
      const taxable = element.taxableAmount as number;
      const nonTaxable = element.nonTaxableAmount as number;
      const taxCalculated = element.taxCalculated as number;

      // No taxable amount => tax rate is 0
      if (taxable == 0) {
        return;
      }

      // No non-taxable amount => tax rate is full rate
      if (nonTaxable == 0) {
        rate += element.rate as number;
        return;
      }

      // Mixed taxable and non-taxable amounts => calculate effective tax rate
      const totalAmount = taxable + nonTaxable;
      rate += Math.round((10000 * taxCalculated) / totalAmount) / 10000;
      return;
    });
    return rate;
  };

  const lines = taxResponse?.lines;

  for (const item of cart?.lineItems || []) {
    const avalaraLineItem = lines?.find(
      (x) => x.itemCode === item?.variant?.sku
    );

    const taxCentAmount = (avalaraLineItem?.tax as number) * 100;

    actions.push({
      action: 'setLineItemTaxRate',
      lineItemId: item.id,
      externalTaxRate: {
        name: 'avaTaxRate',
        amount: taxCentAmount ? rate(avalaraLineItem?.details) : 0,
        country: cart?.country || cart?.shippingAddress?.country,
      },
    });
  }

  for (const item of cart?.customLineItems || []) {
    const avalaraLineItem = lines?.find((x) => x.itemCode === item?.key);
    const taxCentAmount = (avalaraLineItem?.tax as number) * 100;

    actions.push({
      action: 'setCustomLineItemTaxRate',
      customLineItemId: item.id,
      externalTaxRate: {
        name: 'avaTaxRate',
        amount: taxCentAmount ? rate(avalaraLineItem?.details) : 0,
        country: cart?.country || cart?.shippingAddress?.country,
      },
    });
  }

  const avalaraShippingLine = lines?.find((x) => x.itemCode === 'Shipping');
  const shipTaxCentAmount = (avalaraShippingLine?.tax as number) * 100;

  actions.push({
    action: 'setShippingMethodTaxRate',
    shippingKey: cart?.shippingKey,
    externalTaxRate: {
      name: 'avaTaxRate',
      amount: shipTaxCentAmount ? rate(avalaraShippingLine?.details) : 0,
      country: cart?.country || cart?.shippingAddress?.country,
    },
  });

  /*
  No `setCartTotalTax`. It is only valid in `ExternalAmount`, and it was the line
  that carried the unfinished `// minus total cart discount gross` note. In
  `External` commercetools derives the cart total from the line rates itself, so
  there is nothing to state and nothing left to get wrong.
  */

  if (!cart?.custom?.type) {
    actions.push({
      action: 'setCustomType',
      type: {
        key: process.env.ORDER_CUSTOM_TYPE_KEY as string,
        typeId: 'type',
      },
      fields: {
        avalaraHash: hashCart(cart),
      },
    });
  } else {
    actions.push({
      action: 'setCustomField',
      name: 'avalaraHash',
      value: hashCart(cart),
    });
  }

  return actions;
}
