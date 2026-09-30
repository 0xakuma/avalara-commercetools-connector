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
  Which tax mode this cart needs.

  `ExternalAmount` is the right default and what commercetools recommends: AvaTax
  is authoritative for the exact cent, and storing its amounts verbatim keeps the
  cart, the order and the AvaTax document that gets filed in agreement.

  It breaks on exactly one shape. In `ExternalAmount` commercetools does no tax
  arithmetic of its own, so it emits no `taxedPrice.taxPortions`. A cart discount
  targeting `totalPrice` then has nothing to be apportioned across, and
  commercetools deducts it from the cart gross TWICE -- once inside
  `cart.totalPrice`, and again as `discountOnTotalPrice.discountedGrossAmount`.
  The gross lands below the net, `totalTax` goes negative, and the shopper is
  charged roughly the whole tax short.

  `setCartTotalTax` cannot rescue it: commercetools discards `externalTotalGross`
  entirely whenever `discountOnTotalPrice` is present. Verified against a live
  project -- a probe value of 99999 was honoured on an undiscounted cart and
  ignored on a discounted one.

  So for those carts only, we switch to `External` and supply the RATE instead.
  commercetools then computes the amounts, emits tax portions, and apportions the
  discount once. The cost is that it recalculates from the rate using the cart's
  `taxRoundingMode` rather than storing AvaTax's figure, so an amount can differ
  from the AvaTax quote by a cent -- which is why this is not the default.

  NOTE: `hashCart` includes `discountOnTotalPrice` so that applying or removing an
  order-level discount re-triggers this extension. Without that the cart would
  keep whichever mode it already had and the switch would never happen.
  */
  const hasOrderLevelDiscount = !!cart?.discountOnTotalPrice;
  const taxMode = hasOrderLevelDiscount ? 'External' : 'ExternalAmount';

  if (cart?.taxMode !== taxMode) {
    actions.push({ action: 'changeTaxMode', taxMode });
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

  /* The same tax rate object both modes need: `externalTaxRate` on its own in
  `External`, nested inside `externalTaxAmount` in `ExternalAmount`. */
  const taxRateFor = (
    details: TransactionLineDetailModel[] | undefined,
    taxCentAmount: number
  ) => ({
    name: 'avaTaxRate',
    amount: taxCentAmount ? rate(details) : 0,
    country: cart?.country || cart?.shippingAddress?.country,
  });

  let totalTax = 0;

  const lines = taxResponse?.lines;

  for (const item of cart?.lineItems || []) {
    const avalaraLineItem = lines?.find(
      (x) => x.itemCode === item?.variant?.sku
    );

    const taxCentAmount = (avalaraLineItem?.tax as number) * 100;

    totalTax += taxCentAmount;

    if (hasOrderLevelDiscount) {
      actions.push({
        action: 'setLineItemTaxRate',
        lineItemId: item.id,
        externalTaxRate: taxRateFor(avalaraLineItem?.details, taxCentAmount),
      });
    } else {
      actions.push({
        action: 'setLineItemTaxAmount',
        lineItemId: item.id,
        externalTaxAmount: {
          totalGross: {
            currencyCode: cart?.totalPrice?.currencyCode,
            centAmount: item?.totalPrice?.centAmount + taxCentAmount,
          },
          taxRate: taxRateFor(avalaraLineItem?.details, taxCentAmount),
        },
      });
    }
  }

  for (const item of cart?.customLineItems || []) {
    const avalaraLineItem = lines?.find((x) => x.itemCode === item?.key);
    const taxCentAmount = (avalaraLineItem?.tax as number) * 100;

    totalTax += taxCentAmount;

    if (hasOrderLevelDiscount) {
      actions.push({
        action: 'setCustomLineItemTaxRate',
        customLineItemId: item.id,
        externalTaxRate: taxRateFor(avalaraLineItem?.details, taxCentAmount),
      });
    } else {
      actions.push({
        action: 'setCustomLineItemTaxAmount',
        customLineItemId: item.id,
        externalTaxAmount: {
          totalGross: {
            currencyCode: cart?.totalPrice?.currencyCode,
            centAmount: item?.totalPrice?.centAmount + taxCentAmount,
          },
          taxRate: taxRateFor(avalaraLineItem?.details, taxCentAmount),
        },
      });
    }
  }

  const avalaraShippingLine = lines?.find((x) => x.itemCode === 'Shipping');
  const shipTaxCentAmount = (avalaraShippingLine?.tax as number) * 100;

  const shipPrice =
    cart?.shippingInfo?.discountedPrice?.value?.centAmount ??
    (cart?.shippingInfo?.price?.centAmount as number);
  totalTax += shipTaxCentAmount;

  if (hasOrderLevelDiscount) {
    actions.push({
      action: 'setShippingMethodTaxRate',
      shippingKey: cart?.shippingKey,
      externalTaxRate: taxRateFor(
        avalaraShippingLine?.details,
        shipTaxCentAmount
      ),
    });
  } else {
    actions.push({
      action: 'setShippingMethodTaxAmount',
      shippingKey: cart?.shippingKey,
      externalTaxAmount: {
        totalGross: {
          centAmount: shipPrice + shipTaxCentAmount,
          currencyCode: cart?.totalPrice?.currencyCode,
        },
        taxRate: taxRateFor(avalaraShippingLine?.details, shipTaxCentAmount),
      },
    });
  }

  /*
  `setCartTotalTax` only exists in `ExternalAmount`, and on a cart with an
  order-level discount commercetools ignores it anyway (above). In `External`
  commercetools derives the cart total from the line rates itself.

  `cart.totalPrice` carries no order-level discount on this branch -- that is
  what this branch means -- so `totalPrice + totalTax` is the whole gross, and
  the `// minus total cart discount gross` this line used to carry is not a case
  that can reach it.
  */
  if (!hasOrderLevelDiscount) {
    actions.push({
      action: 'setCartTotalTax',
      externalTotalGross: {
        currencyCode: cart?.totalPrice?.currencyCode,
        centAmount: cart?.totalPrice?.centAmount + totalTax,
      },
    });
  }

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
