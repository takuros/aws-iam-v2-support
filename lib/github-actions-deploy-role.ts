import { Construct } from "constructs";
import { Duration, Fn } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";

const GITHUB_ISSUER = "token.actions.githubusercontent.com";

/**
 * GitHub Actions 用のデプロイロール（本文 7.7）
 *
 * - OIDC Provider はアカウントに 1 つです。すでに登録済みなら oidcProviderArn を渡します。
 * - thumbprint は書きません。省くと IAM が取得します（本文 7.7 の CLI も指定していません）。
 * - 2026-07-15 より後に作ったリポジトリでは sub の形が変わります。実際に発行される sub を
 *   subjects に書きます（例: repo:OWNER@123/REPO@456:ref:refs/heads/main）。
 */
export interface GitHubActionsDeployRoleProps {
  /** GitHub のオーナー（組織名またはユーザー名） */
  owner: string;
  /** リポジトリ名 */
  repository: string;
  /** デプロイを許すブランチ（デフォルト main） */
  branch?: string;
  /** sub を直接指定します。指定すると owner・repository・branch より優先します */
  subjects?: string[];
  /** 登録済みの OIDC Provider の ARN（既定は新しく作成） */
  oidcProviderArn?: string;
  /** デプロイ先の S3 バケット名 */
  deployBucketName: string;
  /** 更新してよい Lambda 関数と CloudFormation スタックの名前の接頭辞 */
  resourceNamePrefix: string;
  /** cdk deploy を使うか。bootstrap が作るロールの引き受けを許します（デフォルト false） */
  allowCdkBootstrapRoles?: boolean;
  /** ロール名 */
  roleName?: string;
}

export class GitHubActionsDeployRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: GitHubActionsDeployRoleProps) {
    super(scope, id);

    const subjects = props.subjects ?? [
      `repo:${props.owner}/${props.repository}:ref:refs/heads/${props.branch ?? "main"}`,
    ];
    for (const subject of subjects) {
      // オーナーやリポジトリをワイルドカードにすると、他人のリポジトリからも引き受けられます
      if (!/^repo:[^*?:/]+\/[^*?:/]+:.+$/.test(subject)) {
        throw new Error(`sub must name one owner and one repository: ${subject}`);
      }
    }

    // 空の接頭辞だと、アカウントのすべての関数とスタックが対象になります
    if (props.resourceNamePrefix === "") {
      throw new Error("resourceNamePrefix must not be empty");
    }

    const providerArn =
      props.oidcProviderArn ??
      new iam.OidcProviderNative(this, "GitHubOidcProvider", {
        url: `https://${GITHUB_ISSUER}`,
        clientIds: ["sts.amazonaws.com"],
      }).oidcProviderArn;

    this.role = new iam.Role(this, "Role", {
      roleName: props.roleName ?? "ci-deploy-readwrite",
      description: "Deploy role for GitHub Actions via OIDC",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: { [`${GITHUB_ISSUER}:aud`]: "sts.amazonaws.com" },
        StringLike: { [`${GITHUB_ISSUER}:sub`]: subjects },
      }),
    });

    const prefix = props.resourceNamePrefix;
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AllowListDeployBucket",
        actions: ["s3:ListBucket"],
        resources: [Fn.sub("arn:${AWS::Partition}:s3:::" + props.deployBucketName)],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AllowPutDeployObjects",
        actions: ["s3:PutObject"],
        resources: [Fn.sub("arn:${AWS::Partition}:s3:::" + props.deployBucketName + "/*")],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AllowUpdateFunctionCode",
        actions: ["lambda:UpdateFunctionCode"],
        resources: [Fn.sub("arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:" + prefix + "*")],
      }),
    );
    // スタックの中身は、このロール自身の権限で作られます。足りない操作はここへ足します
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AllowUpdateStacks",
        actions: [
          "cloudformation:CreateChangeSet",
          "cloudformation:DescribeChangeSet",
          "cloudformation:DescribeStackEvents",
          "cloudformation:DescribeStacks",
          "cloudformation:ExecuteChangeSet",
          "cloudformation:GetTemplate",
        ],
        resources: [
          Fn.sub("arn:${AWS::Partition}:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/" + prefix + "*/*"),
        ],
      }),
    );

    if (props.allowCdkBootstrapRoles ?? false) {
      // 既定の qualifier（hnb659fds）の場合です。bootstrap の実行ロールは既定で強い権限を持つので、
      // このオプションを使うなら sub をブランチまで絞ってください
      this.role.addToPolicy(
        new iam.PolicyStatement({
          sid: "AllowAssumeCdkBootstrapRoles",
          actions: ["sts:AssumeRole"],
          resources: [Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-hnb659fds-*")],
        }),
      );
    }
  }
}
