import { Construct } from "constructs";
import { CfnOutput, Fn } from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";

/**
 * ブレイクグラス用 IAM ユーザーとグループ（本文 6.9、6.10、8.9、付録 A）
 *
 * IaC で作るのは IAM ユーザーとグループまでです。長期アクセスキーは発行しません。
 * パスワードと MFA はコンソールで手作業で設定します。
 *
 * Organizations を使わない単一アカウントでは、第 2 章のサインイン用ユーザーとルートユーザーが
 * 最後の手段です。このテンプレートは推奨構成（Organizations と Identity Center）のときに使います。
 */
export interface BreakGlassProps {
  /** IAM ユーザーの名前。bg-<人名> の形で、人ごとに 1 つ作ります。持つのは 2 名が目安です */
  userNames: string[];
  /** スイッチロール先の管理者ロールの名前 */
  adminRoleName: string;
}

export class BreakGlass extends Construct {
  public readonly group: iam.Group;
  public readonly users: iam.User[];

  constructor(scope: Construct, id: string, props: BreakGlassProps) {
    super(scope, id);

    for (const userName of props.userNames) {
      // 名前を bg- にそろえておくと、通知のルールが自動で対象にします
      if (!userName.startsWith("bg-")) {
        throw new Error(`Break-glass user name must start with bg-: ${userName}`);
      }
    }

    this.group = new iam.Group(this, "Group", { groupName: "break-glass" });

    // AdministratorAccess は付けません。許すのは管理者ロールへの切り替えと、自分の MFA・パスワードの管理だけです
    new iam.Policy(this, "Policy", {
      policyName: "BreakGlassSelfManageAndAssume",
      groups: [this.group],
      statements: [
        new iam.PolicyStatement({
          sid: "AllowAssumeAdminRole",
          actions: ["sts:AssumeRole"],
          resources: [Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/" + props.adminRoleName)],
        }),
        new iam.PolicyStatement({
          sid: "AllowSelfManageMFAandPassword",
          actions: [
            "iam:ChangePassword",
            "iam:CreateVirtualMFADevice",
            "iam:DeactivateMFADevice",
            "iam:EnableMFADevice",
            "iam:GetUser",
            "iam:ListMFADevices",
            "iam:ResyncMFADevice",
          ],
          // ${!aws:username} は、Fn::Sub にポリシー変数 ${aws:username} をそのまま残す書き方です
          resources: [
            Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:user/${!aws:username}"),
            Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:mfa/${!aws:username}"),
          ],
        }),
      ],
    });

    this.users = props.userNames.map(
      (userName) =>
        new iam.User(this, `User-${userName}`, {
          userName,
          groups: [this.group],
        }),
    );
  }
}

/**
 * ブレイクグラス用ユーザーのサインインの通知（本文 8.9）
 *
 * サインインの記録先は、使ったサインイン画面のリージョンです。EventBridge は記録された
 * リージョンでしかイベントを受けないので、使われうるリージョンすべてにデプロイします。
 * CloudTrail の証跡は、読み取りと書き込みの両方を記録するマルチリージョン証跡 1 本で足ります。
 */
export class BreakGlassNotification extends Construct {
  public readonly topic: sns.Topic;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.topic = new sns.Topic(this, "Topic", { displayName: "Break-glass sign-in" });
    const target = new targets.SnsTopic(this.topic);
    const breakGlassUser = { arn: events.Match.wildcard("*:user/bg-*") };

    const consoleLogin = new events.Rule(this, "ConsoleLoginRule", {
      description: "Successful console sign-in by a break-glass user",
      eventPattern: {
        detail: {
          eventSource: ["signin.amazonaws.com"],
          eventName: ["ConsoleLogin"],
          userIdentity: breakGlassUser,
          responseElements: { ConsoleLogin: ["Success"] },
        },
      },
      targets: [target],
    });

    // この IAM ユーザーには aws login の権限を与えていないので、記録されたら原因を調べます
    const awsLogin = new events.Rule(this, "AwsLoginRule", {
      description: "aws login by a break-glass user",
      eventPattern: {
        detail: {
          eventSource: ["signin.amazonaws.com"],
          eventName: ["AuthorizeOAuth2Access", "CreateOAuth2Token"],
          userIdentity: breakGlassUser,
        },
      },
      targets: [target],
    });

    // 読み取り系の管理イベントは、ルールの既定の状態では届きません（本文 8.8）
    for (const rule of [consoleLogin, awsLogin]) {
      (rule.node.defaultChild as events.CfnRule).state = "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS";
    }

    new CfnOutput(this, "TopicArn", {
      value: this.topic.topicArn,
      description: "Subscribe everyone who must be notified",
    });
  }
}
