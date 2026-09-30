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

  /* See the note in `postprocess.get.tax.ts`: `External` supplies the rate and
  lets commercetools compute the amounts, so it emits tax portions and applies a
  `totalPrice` discount once instead of twice. */
  if (order.taxMode !== 'External') {
    actions.push({ action: 'changeTaxMode', taxMode: 'External' });
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

  const lines: any = transactionModel?.lines;

  for (const item of order.lineItems || []) {
    const taxCentAmount =
      lines.find((x: any) => x.itemCode === item?.variant?.sku)?.tax * 100;

    actions.push({
      action: 'setLineItemTaxRate',
      lineItemId: item.id,
      externalTaxRate: {
        name: 'avaTaxRate',
        amount: taxCentAmount ? taxRate : 0,
        country,
      },
    });
  }

  for (const item of order?.customLineItems || []) {
    const taxCentAmount =
      lines.find((x: any) => x.itemCode === item?.key)?.tax * 100;

    actions.push({
      action: 'setCustomLineItemTaxRate',
      customLineItemId: item.id,
      externalTaxRate: {
        name: 'avaTaxRate',
        amount: taxCentAmount ? taxRate : 0,
        country,
      },
    });
  }

  const shipTaxCentAmount =
    lines.find((x: any) => x.itemCode === 'Shipping')?.tax * 100;


  actions.push({
    action: 'setShippingMethodTaxRate',
    shippingKey: order?.shippingKey,
    externalTaxRate: {
      name: 'avaTaxRate',
      amount: shipTaxCentAmount ? taxRate : 0,
      country,
    },
  });

  /* No `setOrderTotalTax` -- see the cart note. It was the twin of the line that
  carried `// minus total order discount gross`, and in `External` mode
  commercetools derives the order total from the line rates itself. */

  return actions;
}
