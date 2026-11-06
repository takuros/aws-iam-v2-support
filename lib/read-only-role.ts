import { Construct } from "constructs";
import { Duration, Fn } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * 読み取り専用ロール（監査やレビュー、本文 8.7 の棚卸しに使います）
 *
 * ReadOnlyAccess は S3 のオブジェクトなど、データの中身も読めます。
 * 中身まで見せたくないなら job-function/ViewOnlyAccess に替えます。
 */
export interface ReadOnlyRoleProps {
  /** 切り替えてよいサインイン用 IAM ユーザーの名前 */
  trustedUserNames: string[];
  /** ロール名 */
  roleName?: string;
}

export class ReadOnlyRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: ReadOnlyRoleProps) {
    super(scope, id);

    this.role = new iam.Role(this, "Role", {
      roleName: props.roleName ?? "human-auditor-readonly",
      description: "Read-only role for audit and review",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.CompositePrincipal(
        ...props.trustedUserNames.map(
          (userName) => new iam.ArnPrincipal(Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:user/" + userName)),
        ),
      ).withConditions({ Bool: { "aws:MultiFactorAuthPresent": "true" } }),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess")],
    });

    // ReadOnlyAccess は請求情報にも届きます。付録 A の「請求情報の閲覧を限定」のために拒否します
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DenyBillingAccess",
        effect: iam.Effect.DENY,
        actions: [
          "aws-portal:*",
          "bcm-dashboards:*",
          "bcm-data-exports:*",
          "bcm-pricing-calculator:*",
          "bcm-recommended-actions:*",
          "billing:*",
          "billingconductor:*",
          "budgets:*",
          "ce:*",
          "consolidatedbilling:*",
          "cost-optimization-hub:*",
          "cur:*",
          "freetier:*",
          "invoicing:*",
          "mapcredits:*",
          "payments:*",
          "purchase-orders:*",
          "savingsplans:*",
          "sustainability:*",
          "tax:*",
        ],
        resources: ["*"],
      }),
    );
  }
}
