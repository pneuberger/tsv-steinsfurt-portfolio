import { Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import type { Construct } from 'constructs';

export interface BudgetStackProps extends StackProps {
  /** Who gets the alerts. Passed at deploy time (-c budgetEmail=…) so it never lands in the public repo. */
  email: string;
  /** Monthly limit in USD (AWS Budgets works in USD). */
  limitUsd: number;
}

/** Account-wide monthly cost budget with e-mail alerts. */
export class BudgetStack extends Stack {
  constructor(scope: Construct, id: string, props: BudgetStackProps) {
    super(scope, id, props);

    const subscribers = [{ subscriptionType: 'EMAIL', address: props.email }];
    const alert = (notificationType: 'ACTUAL' | 'FORECASTED', threshold: number) => ({
      notification: {
        notificationType,
        comparisonOperator: 'GREATER_THAN',
        threshold,
        thresholdType: 'PERCENTAGE',
      },
      subscribers,
    });

    new CfnBudget(this, 'MonthlyCostBudget', {
      budget: {
        budgetName: 'tsv-steinsfurt-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.limitUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        alert('ACTUAL', 80), // 80 % already spent
        alert('ACTUAL', 100), // limit exceeded
        alert('FORECASTED', 100), // AWS predicts the month will exceed the limit
      ],
    });
  }
}
