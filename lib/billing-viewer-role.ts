import { Construct } from "constructs";
import { Duration, Fn } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * 請求閲覧ロール（表 6.2 の role/billing-viewer にあたります）
 *
 * 閲覧だけのロールなので、変更の操作を含む job-function/Billing は使いません。
 * AWSBillingReadOnlyAccess に、Cost Explorer の画面で使う読み取りを足します。
 *
 * 請求コンソールは、デフォルトではルートユーザーしか開けません。
 * ルートユーザーで「IAM アクセスの有効化」を済ませておきます（本文 6.3）。
 */
export interface BillingViewerRoleProps {
  /** 切り替えてよいサインイン用 IAM ユーザーの名前 */
  trustedUserNames: string[];
  /** ロール名 */
  roleName?: string;
}

export class BillingViewerRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: BillingViewerRoleProps) {
    super(scope, id);

    this.role = new iam.Role(this, "Role", {
      roleName: props.roleName ?? "human-billing-readonly",
      description: "Billing and Cost Explorer viewer role",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.CompositePrincipal(
        ...props.trustedUserNames.map(
          (userName) => new iam.ArnPrincipal(Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:user/" + userName)),
        ),
      ).withConditions({ Bool: { "aws:MultiFactorAuthPresent": "true" } }),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AWSBillingReadOnlyAccess")],
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AllowCostExplorerRead",
        actions: [
          "ce:DescribeReport",
          "ce:GetCostAndUsageWithResources",
          "ce:GetCostCategories",
          "ce:GetCostForecast",
          "ce:GetReservationPurchaseRecommendation",
          "ce:GetReservationUtilization",
          "ce:GetUsageForecast",
        ],
        resources: ["*"],
      }),
    );
  }
}
