import { Order, StagedOrderUpdateAction } from '@commercetools/platform-sdk';
import { TransactionModel } from 'avatax/lib/models/TransactionModel';
import { logger } from '../../utils/logger.utils';
import { applyOrderEdit, createOrderEdit } from '../../client/post.client';
import { TransactionSummary } from 'avatax/lib/models/TransactionSummary';

export async function createAndApplyOrderEdit(
  transactionModel: TransactionModel,
  order: Order
): Promise<boolean> {
  const orderId = order.id;
  const orderEdit = await createOrderEdit(
    orderId,
    buildOrderEditUpdateActions(transactionModel, order)
  );
  if (!orderEdit) {
    logger.error(
      `No order edit found. Failed to create order edit for order ${orderId} after recalculating transaction`
    );
    return false;
  }
  const result = (await applyOrderEdit(orderEdit))?.result;
  if (!result) {
    logger.error(
      `Failed to apply order edit for order ${orderId} after recalculating transaction`
    );
    return false;
  }
  if (result.type == 'Applied') {
    logger.info(`Order edit applied successfully for order ${orderId}`);
    return true;
  } else {
    logger.error(
      `Order edit ${orderEdit.id} not applied for order ${orderId} with result: ${result.type}`
    );
    return false;
  }
}

export function buildOrderEditUpdateActions(
  transactionModel: TransactionModel,
  order: Order
): StagedOrderUpdateAction[] {
  const actions = [] as StagedOrderUpdateAction[];

  /*
  Mode chosen per order, mirroring `postprocess.get.tax.ts` -- read the long note
  there. `ExternalAmount` keeps AvaTax authoritative for the exact cent; an order
  carrying an order-level discount switches to `External` because commercetools
  deducts such a discount from the gross twice in `ExternalAmount`, and discards
  `setOrderTotalTax` while it does so.
  */
  const hasOrderLevelDiscount = !!order?.discountOnTotalPrice;
  const taxMode = hasOrderLevelDiscount ? 'External' : 'ExternalAmount';

  if (order.taxMode !== taxMode) {
    actions.push({ action: 'changeTaxMode', taxMode });
  }

  const country = (order?.country || order?.shippingAddress?.country) as string;

  const rate = (rateSummaryElement: TransactionSummary) => {
    const taxable = rateSummaryElement.taxable as number;
    const nonTaxable = rateSummaryElement.nonTaxable as number;
    const taxCalculated = rateSummaryElement.taxCalculated as number;

    // No taxable amount => tax rate is 0
    if (taxable == 0) {
      return 0;
    }

    // No non-taxable amount => tax rate is full rate
    if (nonTaxable == 0) {
      return rateSummaryElement.rate as number;
    }

    // Mixed taxable and non-taxable amounts => calculate effective tax rate
    const totalAmount = taxable + nonTaxable;
    return Math.round((10000 * taxCalculated) / totalAmount) / 10000;
  };

  const taxRate = transactionModel.summary
    ?.map((x) => rate(x))
    .reduce((acc, curr) => (acc || 0) + (curr || 0), 0);

  let totalTax = 0;

  const lines: any = transactionModel?.lines;

  for (const item of order.lineItems || []) {
    const taxCentAmount =
      lines.find((x: any) => x.itemCode === item?.variant?.sku)?.tax * 100;

    totalTax += taxCentAmount;

    if (hasOrderLevelDiscount) {
      actions.push({
        action: 'setLineItemTaxRate',
        lineItemId: item.id,
        externalTaxRate: { name: 'avaTaxRate', amount: taxCentAmount ? taxRate : 0, country },
      });
    } else {
      actions.push({
        action: 'setLineItemTaxAmount',
        lineItemId: item.id,
        externalTaxAmount: {
          totalGross: {
            currencyCode: order?.totalPrice?.currencyCode,
            centAmount: item?.totalPrice?.centAmount + taxCentAmount,
          },
          taxRate: { name: 'avaTaxRate', amount: taxCentAmount ? taxRate : 0, country },
        },
      });
    }
  }

  for (const item of order?.customLineItems || []) {
    const taxCentAmount =
      lines.find((x: any) => x.itemCode === item?.key)?.tax * 100;

    totalTax += taxCentAmount;

    if (hasOrderLevelDiscount) {
      actions.push({
        action: 'setCustomLineItemTaxRate',
        customLineItemId: item.id,
        externalTaxRate: { name: 'avaTaxRate', amount: taxCentAmount ? taxRate : 0, country },
      });
    } else {
      actions.push({
        action: 'setCustomLineItemTaxAmount',
        customLineItemId: item.id,
        externalTaxAmount: {
          totalGross: {
            currencyCode: order?.totalPrice?.currencyCode,
            centAmount: item?.totalPrice?.centAmount + taxCentAmount,
          },
          taxRate: { name: 'avaTaxRate', amount: taxCentAmount ? taxRate : 0, country },
        },
      });
    }
  }

  const shipTaxCentAmount =
    lines.find((x: any) => x.itemCode === 'Shipping')?.tax * 100;


  const shipPrice =
    order?.shippingInfo?.discountedPrice?.value?.centAmount ??
    (order?.shippingInfo?.price?.centAmount as number);
  totalTax += shipTaxCentAmount;

  if (hasOrderLevelDiscount) {
    actions.push({
      action: 'setShippingMethodTaxRate',
      shippingKey: order?.shippingKey,
      externalTaxRate: { name: 'avaTaxRate', amount: shipTaxCentAmount ? taxRate : 0, country },
    });
  } else {
    actions.push({
      action: 'setShippingMethodTaxAmount',
      shippingKey: order?.shippingKey,
      externalTaxAmount: {
        totalGross: {
          centAmount: shipPrice + shipTaxCentAmount,
          currencyCode: order?.totalPrice?.currencyCode,
        },
        taxRate: { name: 'avaTaxRate', amount: shipTaxCentAmount ? taxRate : 0, country },
      },
    });
  }

  /*
  `setOrderTotalTax` exists only in `ExternalAmount`, and commercetools ignores
  it whenever `discountOnTotalPrice` is present -- so it is stated only on the
  branch where it is both valid and honoured. `order.totalPrice` carries no
  order-level discount there, which is what makes `totalPrice + totalTax` the
  whole gross and retires the old `// minus total order discount gross` note.
  */
  if (!hasOrderLevelDiscount) {
    actions.push({
      action: 'setOrderTotalTax',
      externalTotalGross: {
        currencyCode: order?.totalPrice?.currencyCode,
        centAmount: order?.totalPrice?.centAmount + totalTax,
      },
    });
  }

  return actions;
}
