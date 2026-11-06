import { Construct } from "constructs";
import { Duration, Fn } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * AI エージェント用ロール（本文 6.6）
 *
 * AI エージェントには長期アクセスキーを渡さず、人とは別の role/agent-* の一時クレデンシャルを
 * 使わせます。このファイルでは次のものを作ります。
 *
 * - AiAgentRole: 第一の手段です。読み取りを中心にし、破壊的な操作を Deny します。
 *   Bedrock の呼び出しと Secrets Manager の参照は、使うときだけ足します。
 * - AgentAssumeAndPassPolicy: 本文リスト「AI エージェント用ロールを命名で絞る」のポリシーです。
 *   エージェントのプロセスやデプロイ処理が使う主体に付けます。
 * - DenyDestructiveViaMcpPolicy: 人の IAM ロールのまま使わせるしかない場合の補いです。
 *   Deny は MCP 経由にしか効かないので、専用ロールの代わりにはなりません（本文 5.3）。
 *
 * role/agent-* は path の無い IAM ロールにだけ一致します。role/dev/agent-x には一致しません。
 */
export interface BedrockInvokeOptions {
  /** モデル ID のパターン（デフォルト anthropic.claude-*） */
  modelIdPattern?: string;
  /** inference profile の接頭辞（デフォルト jp。日本の 2 リージョンを使います） */
  inferenceProfilePrefix?: string;
  /** 呼び出すリージョン（デフォルト ap-northeast-1） */
  sourceRegion?: string;
  /** inference profile の振り分け先リージョン。振り分け先すべての foundation model に許可が要ります */
  destinationRegions?: string[];
}

export interface AiAgentRoleProps {
  /** ロール名。agent- で始めます */
  roleName?: string;
  /** エージェントを起動する人の IAM ユーザーの名前 */
  trustedUserNames?: string[];
  /** エージェントを動かす基盤の IAM ロールの ARN。agent-* 以外の信頼ポリシーには書きません */
  trustedRoleArns?: string[];
  /** MFA を求めるか（デフォルト true）。trustedRoleArns から引き受けるなら false にします */
  requireMfa?: boolean;
  /** 読み取りの基本ポリシー。データの中身まで読ませるなら ReadOnlyAccess にします */
  readPolicyName?: "job-function/ViewOnlyAccess" | "ReadOnlyAccess";
  /** Bedrock の呼び出しを許すときに指定します */
  bedrock?: BedrockInvokeOptions;
  /** Secrets Manager の参照を許すシークレット名の接頭辞（例: myapp）。省くと許しません */
  secretNamePrefix?: string;
}

export class AiAgentRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: AiAgentRoleProps) {
    super(scope, id);

    const roleName = props.roleName ?? "agent-assistant-readonly";
    if (!roleName.startsWith("agent-")) {
      throw new Error(`AI agent role name must start with agent-: ${roleName}`);
    }

    const principals: iam.IPrincipal[] = [
      ...(props.trustedUserNames ?? []).map(
        (userName) => new iam.ArnPrincipal(Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:user/" + userName)),
      ),
      ...(props.trustedRoleArns ?? []).map((arn) => new iam.ArnPrincipal(arn)),
    ];
    if (principals.length === 0) {
      throw new Error("Specify trustedUserNames or trustedRoleArns");
    }
    const conditions: { [key: string]: any } = {};
    if (props.requireMfa ?? true) {
      conditions.Bool = { "aws:MultiFactorAuthPresent": "true" };
    }

    this.role = new iam.Role(this, "Role", {
      roleName,
      description: "AI agent role, separated from human roles",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.CompositePrincipal(...principals).withConditions(conditions),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(props.readPolicyName ?? "job-function/ViewOnlyAccess"),
      ],
    });

    // 条件なしの Deny です。MCP 経由でも CLI や SDK の直接呼び出しでも効きます
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DenyDestructiveActions",
        effect: iam.Effect.DENY,
        actions: [
          "cloudtrail:DeleteTrail",
          "cloudtrail:StopLogging",
          "dynamodb:DeleteTable",
          "ec2:TerminateInstances",
          "iam:Attach*",
          "iam:Create*",
          "iam:Delete*",
          "iam:PassRole",
          "iam:Put*",
          "iam:Update*",
          "kms:ScheduleKeyDeletion",
          "lambda:DeleteFunction",
          "logs:DeleteLogGroup",
          "rds:DeleteDBCluster",
          "rds:DeleteDBInstance",
          "s3:DeleteBucket",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "secretsmanager:DeleteSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:UpdateSecret",
        ],
        resources: ["*"],
      }),
    );

    // ReadOnlyAccess は請求情報にも届きます。ViewOnlyAccess には請求の操作がないので、このときだけ足します
    if (props.readPolicyName === "ReadOnlyAccess") {
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

    if (props.bedrock) {
      this.role.addManagedPolicy(this.createBedrockInvokePolicy(roleName, props.bedrock));
    }
    if (props.secretNamePrefix) {
      this.role.addManagedPolicy(this.createSecretsReadPolicy(roleName, props.secretNamePrefix));
    }
  }

  /**
   * inference profile の ARN と、振り分け先すべての foundation model の ARN を許します。
   * foundation model は bedrock:InferenceProfileArn 条件で、inference profile 経由に限ります。
   * モデル ID を直接指定した呼び出しは許しません。
   * global. で始まる inference profile は、この形では足りません。README を見てください。
   *
   * ポリシー名はロール名から作ります。AI エージェント用ロールを作業ごとに分けても衝突しません。
   */
  private createBedrockInvokePolicy(roleName: string, options: BedrockInvokeOptions): iam.ManagedPolicy {
    const modelIdPattern = options.modelIdPattern ?? "anthropic.claude-*";
    const profilePrefix = options.inferenceProfilePrefix ?? "jp";
    const sourceRegion = options.sourceRegion ?? "ap-northeast-1";
    const destinationRegions = options.destinationRegions ?? ["ap-northeast-1", "ap-northeast-3"];

    const actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"];
    const inferenceProfiles = Fn.sub(
      "arn:${AWS::Partition}:bedrock:" +
        sourceRegion +
        ":${AWS::AccountId}:inference-profile/" +
        profilePrefix +
        "." +
        modelIdPattern,
    );

    return new iam.ManagedPolicy(this, "BedrockInvoke", {
      managedPolicyName: `${roleName}-bedrock-invoke`,
      statements: [
        new iam.PolicyStatement({
          sid: "InvokeInferenceProfiles",
          actions,
          resources: [inferenceProfiles],
        }),
        new iam.PolicyStatement({
          sid: "InvokeModelsThroughInferenceProfiles",
          actions,
          resources: destinationRegions.map((region) =>
            Fn.sub("arn:${AWS::Partition}:bedrock:" + region + "::foundation-model/" + modelIdPattern),
          ),
          conditions: {
            ArnLike: { "bedrock:InferenceProfileArn": inferenceProfiles },
          },
        }),
      ],
    });
  }

  /**
   * シークレットの ARN は末尾にランダムな文字列が付くので、接頭辞とワイルドカードで書きます。
   * カスタマー管理キーで暗号化したシークレットには、kms:Decrypt の許可も要ります。
   */
  private createSecretsReadPolicy(roleName: string, secretNamePrefix: string): iam.ManagedPolicy {
    return new iam.ManagedPolicy(this, "SecretsRead", {
      managedPolicyName: `${roleName}-secrets-read`,
      statements: [
        new iam.PolicyStatement({
          sid: "ReadAppSecretsOnly",
          actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"],
          resources: [
            Fn.sub(
              "arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:" +
                secretNamePrefix +
                "/*",
            ),
          ],
        }),
      ],
    });
  }
}

/** エージェントのプロセスやデプロイ処理が使う主体に付けるポリシーです */
export class AgentAssumeAndPassPolicy extends Construct {
  public readonly policy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const agentRoles = Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/agent-*");

    this.policy = new iam.ManagedPolicy(this, "Policy", {
      managedPolicyName: "AgentAssumeAndPass",
      description: "Limits AssumeRole and PassRole to role/agent-*",
      statements: [
        new iam.PolicyStatement({
          sid: "AssumeAgentRoles",
          actions: ["sts:AssumeRole"],
          resources: [agentRoles],
        }),
        new iam.PolicyStatement({
          sid: "PassAgentRolesToServices",
          actions: ["iam:PassRole"],
          resources: [agentRoles],
          conditions: {
            StringEquals: {
              "iam:PassedToService": ["lambda.amazonaws.com", "bedrock-agentcore.amazonaws.com"],
            },
          },
        }),
      ],
    });
  }
}

/** 人の IAM ロールのまま AI エージェントに使わせるしかない場合に、その IAM ロールへ付けます */
export class DenyDestructiveViaMcpPolicy extends Construct {
  public readonly policy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.policy = new iam.ManagedPolicy(this, "Policy", {
      managedPolicyName: "DenyDestructiveViaMcp",
      description: "Denies destructive actions called through AWS managed MCP services",
      statements: [
        new iam.PolicyStatement({
          sid: "DenyDestructiveViaMcp",
          effect: iam.Effect.DENY,
          actions: ["dynamodb:DeleteTable", "s3:DeleteBucket", "s3:DeleteObject"],
          resources: ["*"],
          conditions: {
            Bool: { "aws:ViaAWSMCPService": "true" },
          },
        }),
      ],
    });
  }
}
