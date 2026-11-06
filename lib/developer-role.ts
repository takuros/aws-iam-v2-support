import { Construct } from "constructs";
import { Aws, Duration, Fn } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * 開発者ロール（本文 9.9 の Construct を土台に、5.4 の Permissions Boundary を足したものです）
 *
 * delegateRoleCreation で 2 つの形を選びます。
 *
 * - false（既定）: 本文 9.9 と同じ形です。IAM ロールは開発者に作らせず、コードとレビューで管理します。
 *   本文 5.4 のとおり、多くの現場ではこちらで足ります。
 * - true: IAM ロールの作成を開発チームに任せる形です。開発者ロール自身に DeveloperBoundary を付け、
 *   作れるのは DevTeamBoundary を付けた dev-* ロールだけにします。
 */
export interface DeveloperRoleProps {
  /** ロール名（プロジェクトごとに変える） */
  roleName: string;
  /** AssumeRole を許可するアカウント ID（既定はデプロイ先のアカウント） */
  trustedAccountId?: string;
  /** 指定すると、この IAM ユーザーだけに引き受けを許します（既定はアカウント全体） */
  trustedUserNames?: string[];
  /** MFA を強制するか（デフォルト true） */
  requireMfa?: boolean;
  /** IAM ロールの作成を開発チームに任せるか（デフォルト false） */
  delegateRoleCreation?: boolean;
  /** delegateRoleCreation のときに開発者へ許すサービス */
  allowedServices?: string[];
  /** delegateRoleCreation のときに dev-* ロールを渡せるサービス（デフォルト Lambda だけ） */
  passRoleToServices?: string[];
}

export class DeveloperRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: DeveloperRoleProps) {
    super(scope, id);

    const conditions: { [key: string]: any } = {};
    if (props.requireMfa ?? true) {
      conditions.Bool = { "aws:MultiFactorAuthPresent": "true" };
    }

    const accountId = props.trustedAccountId ?? Aws.ACCOUNT_ID;
    const assumedBy = props.trustedUserNames
      ? new iam.CompositePrincipal(
          ...props.trustedUserNames.map(
            (userName) =>
              new iam.ArnPrincipal(Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:user/" + userName)),
          ),
        ).withConditions(conditions)
      : new iam.AccountPrincipal(accountId).withConditions(conditions);

    const delegate = props.delegateRoleCreation ?? false;
    const passRoleToServices = props.passRoleToServices ?? ["lambda.amazonaws.com"];

    this.role = new iam.Role(this, "Role", {
      roleName: props.roleName,
      description: "Developer role",
      maxSessionDuration: Duration.hours(1),
      assumedBy,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("PowerUserAccess")],
      permissionsBoundary: delegate ? this.createDeveloperBoundary(props, passRoleToServices) : undefined,
    });

    if (delegate) {
      this.addRoleCreationDelegation(passRoleToServices);
    } else {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ["iam:Create*", "iam:Delete*", "iam:Update*"],
          resources: ["*"],
        }),
      );
      // PowerUserAccess の sts:* では CDK の bootstrap ロールを引き受けられます。deploy-role から
      // cfn-exec-role を経由すると、上の IAM の Deny を回避できてしまうので拒否します。
      // CDK でのデプロイは GitHubActionsDeployRole の allowCdkBootstrapRoles で行います
      this.role.addToPolicy(
        new iam.PolicyStatement({
          sid: "DenyAssumeCdkBootstrapRoles",
          effect: iam.Effect.DENY,
          actions: ["sts:AssumeRole"],
          resources: [Fn.sub("arn:${AWS::Partition}:iam::*:role/cdk-*")],
        }),
      );
      // PowerUserAccess は請求情報にも届きます。付録 A の「請求情報の閲覧を限定」のために拒否します
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

  /** 開発者ロール自身の上限です。ID 側の PowerUserAccess との積集合が実際の権限になります */
  private createDeveloperBoundary(props: DeveloperRoleProps, passRoleToServices: string[]): iam.ManagedPolicy {
    const services = props.allowedServices ?? ["cloudwatch", "dynamodb", "ec2", "lambda", "logs", "s3"];
    return new iam.ManagedPolicy(this, "DeveloperBoundary", {
      managedPolicyName: "DeveloperBoundary",
      statements: [
        new iam.PolicyStatement({
          sid: "AllowDeveloperServices",
          actions: services.map((service) => `${service}:*`),
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          sid: "AllowDelegatedIam",
          actions: [
            "iam:AttachRolePolicy",
            "iam:CreateRole",
            "iam:DeleteRole",
            "iam:DeleteRolePolicy",
            "iam:DetachRolePolicy",
            "iam:GetRole",
            "iam:GetRolePolicy",
            "iam:ListAttachedRolePolicies",
            "iam:ListRolePolicies",
            "iam:PutRolePolicy",
          ],
          resources: [Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/dev-*")],
        }),
        // 委譲ポリシーと同じ渡し先に絞ります。Boundary から外すと、委譲先が PassRole を使えません
        new iam.PolicyStatement({
          sid: "AllowPassDevRoles",
          actions: ["iam:PassRole"],
          resources: [Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/dev-*")],
          conditions: {
            StringEquals: { "iam:PassedToService": passRoleToServices },
          },
        }),
        // PowerUserAccess が持つ IAM の操作のうち、開発で使うものも上限に入れておきます
        new iam.PolicyStatement({
          sid: "AllowServiceLinkedRolesAndListRoles",
          actions: ["iam:CreateServiceLinkedRole", "iam:ListRoles"],
          resources: ["*"],
        }),
        // Boundary を外す操作と Organizations 系 API は、決して許しません（本文 5.1）
        new iam.PolicyStatement({
          sid: "DenyBoundaryRemovalAndOrganizations",
          effect: iam.Effect.DENY,
          actions: [
            "iam:CreatePolicyVersion",
            "iam:DeleteRolePermissionsBoundary",
            "iam:PutRolePermissionsBoundary",
            "organizations:*",
          ],
          resources: ["*"],
        }),
      ],
    });
  }

  /** 本文 5.4 の委譲ポリシーです。DevTeamBoundary を付けた dev-* ロールだけを作れます */
  private addRoleCreationDelegation(passRoleToServices: string[]): void {
    const devTeamBoundary = new iam.ManagedPolicy(this, "DevTeamBoundary", {
      managedPolicyName: "DevTeamBoundary",
      statements: [
        new iam.PolicyStatement({
          actions: ["s3:*", "dynamodb:*", "logs:*", "lambda:*"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ["iam:*", "organizations:*", "sts:AssumeRole"],
          resources: ["*"],
        }),
      ],
    });

    const devRoles = Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/dev-*");

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AllowManageDevRolesWithBoundary",
        actions: [
          "iam:AttachRolePolicy",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:DeleteRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PutRolePolicy",
        ],
        resources: [devRoles],
        conditions: {
          StringEquals: { "iam:PermissionsBoundary": devTeamBoundary.managedPolicyArn },
        },
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AllowReadDevRoles",
        actions: ["iam:GetRole", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies"],
        resources: [devRoles],
      }),
    );
    // iam:PassRole には iam:PermissionsBoundary 条件が効きません。既存の dev-* ロールも渡せます
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AllowPassDevRoles",
        actions: ["iam:PassRole"],
        resources: [devRoles],
        conditions: {
          StringEquals: { "iam:PassedToService": passRoleToServices },
        },
      }),
    );
  }
}
