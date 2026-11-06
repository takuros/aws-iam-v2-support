import { Construct } from "constructs";
import { Duration, Fn } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * 運用者ロール（表 6.2 の role/operator にあたります）
 *
 * 監視・障害対応・読み取りが中心です。ReadOnlyAccess に、障害対応で使う
 * 最小限の操作だけを足します。足す操作は、自分の運用手順に合わせて増減します。
 */
export interface OperatorRoleProps {
  /** 切り替えてよいサインイン用 IAM ユーザーの名前 */
  trustedUserNames: string[];
  /** ロール名 */
  roleName?: string;
}

export class OperatorRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: OperatorRoleProps) {
    super(scope, id);

    this.role = new iam.Role(this, "Role", {
      roleName: props.roleName ?? "human-operator-readwrite",
      description: "Operator role for monitoring and incident response",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.CompositePrincipal(
        ...props.trustedUserNames.map(
          (userName) => new iam.ArnPrincipal(Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:user/" + userName)),
        ),
      ).withConditions({ Bool: { "aws:MultiFactorAuthPresent": "true" } }),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess")],
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AllowIncidentResponse",
        actions: [
          "cloudwatch:DisableAlarmActions",
          "cloudwatch:EnableAlarmActions",
          "ec2:RebootInstances",
          "ec2:StartInstances",
          "ec2:StopInstances",
          "rds:RebootDBInstance",
        ],
        resources: ["*"],
      }),
    );
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
