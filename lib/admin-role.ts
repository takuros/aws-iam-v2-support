import { Construct } from "constructs";
import { Duration, Fn } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * 管理者ロール（本文 第 2 章の AdminRole、表 6.2 の role/admin にあたります）
 *
 * - 権限は AdministratorAccess です。
 * - 信頼ポリシーは IAM ユーザーを名指しし、MFA と MFA Age（1 時間以内）を求めます。
 * - ブレイクグラス用ユーザーは Statement を分けます。IP 制限を足すときも、
 *   こちらには足さないでください（本文 8.10）。
 */
export interface AdminRoleProps {
  /** 切り替えてよいサインイン用 IAM ユーザーの名前。この IAM ユーザーは先に作っておきます */
  trustedUserNames: string[];
  /** ブレイクグラス用 IAM ユーザーの名前（bg-<人名>）。使わないなら省きます */
  breakGlassUserNames?: string[];
  /** ロール名 */
  roleName?: string;
}

export class AdminRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: AdminRoleProps) {
    super(scope, id);

    const mfaConditions = {
      Bool: { "aws:MultiFactorAuthPresent": "true" },
      NumericLessThan: { "aws:MultiFactorAuthAge": "3600" },
    };
    const toPrincipal = (userName: string) =>
      new iam.ArnPrincipal(Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:user/" + userName));

    this.role = new iam.Role(this, "Role", {
      roleName: props.roleName ?? "human-account-admin",
      description: "Administrator role assumed by named IAM users with MFA",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.CompositePrincipal(...props.trustedUserNames.map(toPrincipal)).withConditions(mfaConditions),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess")],
    });

    const breakGlassUserNames = props.breakGlassUserNames ?? [];
    if (breakGlassUserNames.length > 0) {
      this.role.assumeRolePolicy?.addStatements(
        new iam.PolicyStatement({
          sid: "AllowBreakGlassUsersToAssume",
          actions: ["sts:AssumeRole"],
          principals: breakGlassUserNames.map(toPrincipal),
          conditions: mfaConditions,
        }),
      );
    }
  }
}
