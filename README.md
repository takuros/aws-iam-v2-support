# aws-iam-v2-support

『AWSの薄い本1 IAMのマニアックな話 改訂第2版』のサポートリポジトリです。本書の第 9 章で案内している職務別テンプレ集を収録しています。

職務ごとのロールを CDK（TypeScript）の Construct にしてあり、1 ファイルをコピーして自分の CDK アプリで使えます。合成した CloudFormation テンプレートも `cfn/` に付けています。単一の AWS アカウントを、個人や少人数で運用する場面を想定しています。

## 収録一覧

全部を作る必要はありません。個人なら管理者ロールだけで始められます（付録 A）。チームなら、表 6.2 の 4 種（管理者・開発者・運用者・請求閲覧）が目安です。

| 職務 | Construct | CFn テンプレート | 既定のロール名 | 本文 |
|---|---|---|---|---|
| 管理者 | `lib/admin-role.ts` | `cfn/admin-role.yaml` | `human-account-admin` | 第 2 章、6.3、8.10 |
| 開発者（Permissions Boundary つき、IAM ロールの作成を任せる形） | `lib/developer-role.ts` | `cfn/developer-role.yaml` | `human-developer-readwrite` | 4.3、5.4、6.3 |
| 開発者（Boundary なし、IAM の書き込みを Deny する形） | `lib/developer-role.ts` | `cfn/developer-role-no-boundary.yaml` | `human-developer-simple-readwrite` | 5.4、9.8、9.9 |
| 運用者 | `lib/operator-role.ts` | `cfn/operator-role.yaml` | `human-operator-readwrite` | 6.3 |
| 読み取り専用（監査・棚卸し） | `lib/read-only-role.ts` | `cfn/read-only-role.yaml` | `human-auditor-readonly` | 8.7 |
| 請求閲覧 | `lib/billing-viewer-role.ts` | `cfn/billing-viewer-role.yaml` | `human-billing-readonly` | 6.3、付録 A |
| GitHub Actions 用デプロイ（OIDC） | `lib/github-actions-deploy-role.ts` | `cfn/github-actions-deploy-role.yaml` | `ci-deploy-readwrite` | 7.7 |
| AI エージェント（Bedrock 呼び出し、Secrets Manager 参照を含む） | `lib/ai-agent-role.ts` | `cfn/ai-agent-role.yaml` | `agent-assistant-readonly` | 5.3、6.6 |
| ブレイクグラス用 IAM ユーザーとグループ | `lib/break-glass.ts` | `cfn/break-glass.yaml` | `bg-<人名>`、グループ `break-glass` | 6.9、6.10、付録 A |
| ブレイクグラスの通知 | `lib/break-glass.ts` | `cfn/break-glass-notification.yaml` | — | 8.8、8.9 |

開発者ロールは 2 つの形のどちらかを選びます。本文 5.4 のとおり、IAM ロールの作成を開発チームに任せる必要がなければ、Boundary なしの形で足ります。

### ロール名の決め方

既定のロール名は、本文 6.3 の命名規則（役割接頭辞 `human` / `ci` / `agent`、用途、粒度の接尾辞）に合わせています。本文の例との対応は次のとおりです。名前は `bin/settings.ts` で変えられます。

| 本文の例 | このリポジトリの既定 |
|---|---|
| `AdminRole`、`role/admin` | `human-account-admin` |
| `role/developer` | `human-developer-readwrite` |
| `role/operator` | `human-operator-readwrite` |
| `role/billing-viewer` | `human-billing-readonly` |
| `GitHubDeployRole` | `ci-deploy-readwrite` |
| `role/agent-*` | `agent-assistant-readonly` |

第 2 章で `AdminRole` を手で作っている場合、同じ名前ではデプロイできません。既定の名前のまま新しいロールを作り、切り替えられることを確かめてから、古い `AdminRole` を消します。

環境を path で表す場合は注意が要ります。本文の `role/agent-*` は path の無い IAM ロールにだけ一致し、`role/dev/agent-x` には一致しません。AI エージェント用ロールには path を付けないでください。

## 使い方

Node.js 20 以降と AWS CLI を用意します。AWS CLI はデプロイと Policy Validation に使います。

### 1 ファイルをコピーして使う

`lib/` の各ファイルが使うのは `aws-cdk-lib` と `constructs` だけです。自分の CDK アプリの `lib/` にコピーし、スタックから呼び出します。

```ts
import { DeveloperRole } from "./developer-role";

new DeveloperRole(this, "WebDev", {
  roleName: "human-developer-readwrite",
  trustedUserNames: ["your-signin-user"],
});
```

### リポジトリごと使う

```console
$ git clone https://github.com/takuros/aws-iam-v2-support.git
$ cd aws-iam-v2-support
$ npm ci
```

`bin/settings.ts` の値を差し替えてから、必要なスタックだけをデプロイします。全スタックをまとめてデプロイしないでください。

デプロイと検証には管理者の権限が要ります。以下のコマンドは、第 2 章の `admin` profile を使う例です。先に `aws login` を済ませ、`sts get-caller-identity` で MFA のコードを入れておきます。

```console
$ aws --profile admin sts get-caller-identity
$ npm run cfn
$ npm test
$ AWS_PROFILE=admin npm run validate
$ npx cdk deploy IamOperatorRole --profile admin
```

`npx cdk deploy` は AWS CLI のキャッシュを使わないので、MFA のコードをもう一度聞かれることがあります。聞かれても答えられない環境では、AWS CLI が持つ一時クレデンシャルを環境変数で渡します。

```console
$ eval "$(aws configure export-credentials --profile admin --format env)"
$ export AWS_REGION=ap-northeast-1
$ npx cdk deploy IamOperatorRole
```

`bin/app.ts` のスタックはアセットを持たず、テンプレートも小さいので、`cdk bootstrap` なしで手元の認証情報からデプロイする設定です。

### CloudFormation で使う

`cfn/` のテンプレートの値を差し替えて、そのままデプロイできます。ロール名を固定しているので `CAPABILITY_NAMED_IAM` が要ります。

```console
$ aws --profile admin sts get-caller-identity
$ aws cloudformation deploy --profile admin \
    --template-file cfn/operator-role.yaml \
    --stack-name iam-operator-role \
    --capabilities CAPABILITY_NAMED_IAM
```

### 差し替える値

アカウント ID を書く場所はありません。デプロイ先のアカウントが `AWS::AccountId` で入ります。

| 値 | 場所（`bin/settings.ts`） | 既定の例 | 説明 |
|---|---|---|---|
| サインイン用 IAM ユーザー | `trustedUsers` | `example-signin-user` | 切り替えてよい IAM ユーザーです。ロールごとに書きます |
| ブレイクグラス用 IAM ユーザー | `breakGlassUsers` | `bg-member1`、`bg-member2` | `bg-<人名>` の形にします。作らないなら空の配列にします |
| ロール名 | `roleNames` | 上の表のとおり | 本文の命名規則で付けます |
| GitHub のリポジトリ | `github.owner`、`github.repository`、`github.branch` | `my-org`、`my-repo`、`main` | 信頼ポリシーの `sub` になります |
| デプロイ先 | `github.deployBucketName`、`github.resourceNamePrefix` | `example-deploy-bucket`、`example-app-` | S3 バケットと、Lambda 関数・スタックの名前の接頭辞です |
| 登録済みの OIDC Provider | `github.oidcProviderArn` | 未指定（新しく作成） | 本文 7.7 の手順で登録済みなら ARN を書きます。書かないと同じ URL の Provider を作ろうとして失敗します |
| シークレットの接頭辞 | `agentSecretNamePrefix` | `myapp` | `myapp/` で始まるシークレットだけを読めます |

信頼ポリシーに書く IAM ユーザーは、デプロイの前に存在している必要があります。例の値のままデプロイすると失敗します。

CloudFormation で直接使うときは、YAML の中の同じ値を替えます。

- `cfn/admin-role.yaml` からブレイクグラス用ユーザーを除くなら、`AllowBreakGlassUsersToAssume` の Statement を消します。
- OIDC Provider を登録済みなら、`cfn/github-actions-deploy-role.yaml` の `AWS::IAM::OIDCProvider` のリソースを消し、信頼ポリシーの `Federated` の値を `Fn::Sub: arn:${AWS::Partition}:iam::${AWS::AccountId}:oidc-provider/token.actions.githubusercontent.com` に替えます（`npm run validate` が短縮形の `!Sub` を解決しないので、長い形で書きます）。

管理ポリシーの名前には、次の決まりがあります。

- `DeveloperBoundary`、`DevTeamBoundary`、`AgentAssumeAndPass`、`DenyDestructiveViaMcp` は名前が固定で、1 つのアカウントに 1 つです。`DevTeamBoundary` は本文 5.4 の名前のままにしてあります。Boundary つきの開発者ロールの `roleName` を変えて 2 つ目を作ると、名前が衝突します。人を増やすなら `trustedUserNames` に足します。
- AI エージェント用ロールのポリシーの名前は `<ロール名>-bedrock-invoke`、`<ロール名>-secrets-read` です。作業ごとにロールを分けても衝突しません。

## デプロイ前の検証

デプロイの前に、IAM Access Analyzer の Policy Validation を必ず通してください（本文 9.5、9.11）。値を差し替えたあと、次のコマンドで `cfn/` のすべてのポリシーを検証します。ERROR か SECURITY_WARNING が 1 件でもあれば、終了コード 1 で止まります。

```console
$ aws --profile admin sts get-caller-identity
$ npm run cfn
$ AWS_PROFILE=admin npm run validate
```

`npm run validate` は AWS CLI の `aws accessanalyzer validate-policy` を呼びます。認証情報が要りますが、読み取りの API だけです。検証するポリシーの一覧だけを見るなら `npm run validate -- --dry-run` を使います。

検証の対象は、IAM ロールの信頼ポリシー、インラインポリシー、カスタマー管理ポリシーです。SNS のトピックポリシーなど IAM 以外のリソースのポリシーと、AWS 管理ポリシーの中身は対象外です。

Policy Validation が見るのはポリシー単体です。Boundary や信頼ポリシーとの組み合わせまでは見ません（本文 9.5）。

### 確かめた範囲

このリポジトリで確かめたのは次の 3 つです。

- 合成（`cdk synth`）、Jest のテスト、`tsc`、`cfn-lint` が通ること
- ポリシーのアクションが Service Authorization Reference に実在すること
- `npm run validate -- --dry-run` でポリシーを取り出せること

Policy Validation の実行と、実際のアカウントへのデプロイはしていません。`cdk bootstrap` なしのデプロイ、MFA の入力、通知のルールも含めて、自分の環境で確かめてください。

## 職務ごとの注意

**管理者**: 信頼ポリシーは、名指しした IAM ユーザーに MFA と MFA Age（1 時間以内）を求めます。IAM Identity Center でサインインする人に限るときは、本文 6.2 の書き方に替えます。

**開発者（Boundary つき）**: 開発者ロール自身に `DeveloperBoundary` を付け、開発者が作る IAM ロールには `DevTeamBoundary` を強制します。`DevTeamBoundary` は `iam:*` を拒否するので、開発者ロール自身には付けられません。作れるのは `dev-*` のロールだけで、渡せる先は既定で Lambda だけです。使うサービスが増えたら `allowedServices`、`passRoleToServices`、`DevTeamBoundary` を見直します。

- 導入の前に、Boundary の無い強い `dev-*` ロールが無いことを確かめてください。`iam:PassRole` には `iam:PermissionsBoundary` 条件が効かないので、既存の `dev-*` ロールは Boundary が無くても Lambda に渡せます。
- `dev-*` の信頼ポリシーは開発者が自由に書けるので、外部アカウントを信頼する IAM ロールも作れます。IAM Access Analyzer の External Access で検出してください（本文 9.3）。

**開発者（Boundary なし）**: `PowerUserAccess` は `sts:*` を含みます。CDK の bootstrap が作る `deploy-role` から `cfn-exec-role` を経由すると IAM の Deny を回避できるので、`role/cdk-*` への `sts:AssumeRole` を Deny しています。このロールから手元で bootstrap ロールを使う `cdk deploy` はできないので、CDK でのデプロイは GitHub Actions 用ロールの `allowCdkBootstrapRoles` で行います。アカウント全体を信頼する IAM ロールをほかに作ると、同じ経路ができます。運用者、読み取り専用、AI エージェントのロールには `sts:AssumeRole` の許可がなく、この経路はありません。

**運用者**: `ReadOnlyAccess` に、EC2 と RDS の再起動などの最小限の操作を足した形です。足す操作は自分の運用手順に合わせます。

**読み取り専用**: `ReadOnlyAccess` は S3 のオブジェクトなど、データの中身も読めます。中身まで見せないなら `job-function/ViewOnlyAccess` に替えます。

**請求閲覧**: ルートユーザーで「IAM アクセスの有効化」を済ませておきます（本文 6.3）。`PowerUserAccess` と `ReadOnlyAccess` は請求情報にも届くので、開発者（Boundary なし）、運用者、読み取り専用のロールでは請求と費用の関連サービスを Deny しています（付録 A）。公開情報の `pricing` は対象にしていません。

**GitHub Actions**: OIDC Provider はアカウントに 1 つです。本文 7.7 の手順で登録済みなら `bin/settings.ts` の `github.oidcProviderArn` に ARN を書きます。thumbprint は指定しません。2026-07-15 より後に作ったリポジトリでは、既定の `sub` が `repo:OWNER@ID/REPO@ID:…` の形になるので、実際に発行される値を `subjects` に書きます。それ以前のリポジトリでも、この形を選んだ場合や、2026-07-15 より後に名前の変更・移管をした場合は同じです。GitHub Enterprise Server にこの形はありません。`cdk deploy` を使うなら `allowCdkBootstrapRoles` を有効にしますが、bootstrap の実行ロールは既定で強い権限を持ちます。

**AI エージェント**: 第一の手段は AI 専用の IAM ロールです。人の IAM ユーザーから MFA 付きで引き受け、エージェントにはその一時クレデンシャルだけを渡します。人の手元の `~/.aws/config` に、第 2 章と同じ形の profile を足します。

```ini
[profile agent]
region = ap-northeast-1
role_arn = arn:aws:iam::123456789012:role/agent-assistant-readonly
source_profile = your-signin-user
mfa_serial = arn:aws:iam::123456789012:mfa/your-signin-user
role_session_name = your-signin-user-agent
duration_seconds = 3600
```

人が MFA のコードを入れてから、一時クレデンシャルを環境変数にして、エージェントを起動します。エージェントに渡るのは環境変数だけで、1 時間たつと失効します。

```console
$ aws --profile agent sts get-caller-identity
$ eval "$(aws configure export-credentials --profile agent --format env)"
$ export AWS_REGION=ap-northeast-1
$ （AI エージェントの起動コマンド）
```

同じ OS ユーザーで動かすと、エージェントは `~/.aws/` の設定やキャッシュも読めます。ほかの profile を使わせないよう、エージェントのファイルの読み取りを制限してください。

- 読み取りの基本は `job-function/ViewOnlyAccess` です。データの中身まで読ませるときだけ `readPolicyName` を `ReadOnlyAccess` にします。このときは請求情報の Deny が自動で付きます。
- 破壊的な操作の Deny には条件を付けていません。MCP 経由でも、CLI や SDK の直接呼び出しでも効きます。
- `AgentAssumeAndPass` は、エージェントのプロセスやデプロイ処理が使う主体に付けるポリシーです。同じアカウントでは、信頼ポリシーがその主体を直接指定していると、このポリシーの許可がなくても引き受けられます。`agent-*` 以外の IAM ロールの信頼ポリシーに、エージェントを書かないでください（本文 6.6）。
- `DenyDestructiveViaMcp` は、人の IAM ロールのまま使わせるしかない場合の補いです。MCP 経由の呼び出しにしか効きません（本文 5.3）。
- Bedrock の既定は、東京から `jp.` の inference profile を呼ぶ形です。振り分け先の東京と大阪の foundation model は、`bedrock:InferenceProfileArn` 条件で inference profile 経由に限っています。モデル ID を直接指定した呼び出しは許しません。[`global.` の inference profile](https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html) には別の形のポリシーが要るので、このテンプレートのままでは使えません。
- AWS Marketplace から提供されるモデルは、アカウントで初めて使うときだけ `aws-marketplace:Subscribe` などの権限が要ります。このロールには付けていないので、[権限を持つ人が先に有効化](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)します。
- カスタマー管理キーで暗号化したシークレットを読むには、`kms:Decrypt` の許可も要ります。

**ブレイクグラス**: 推奨構成（Organizations と IAM Identity Center）のときに作ります。Organizations を使わない単一アカウントでは、第 2 章のサインイン用ユーザーとルートユーザーが最後の手段です。

- 作るのは IAM ユーザーとグループまでです。長期アクセスキーは発行しません。パスワードと MFA はコンソールで設定します（本文 6.9）。
- `IamAdminRole` は `IamBreakGlass` のあとにデプロイされます。信頼ポリシーに書く `bg-` の IAM ユーザーが先に要るためです。
- 通知は `cfn/break-glass-notification.yaml` で作ります。サインインの記録先は使ったサインイン画面のリージョンなので、使われうるリージョンすべてにデプロイします。リージョンの一覧は自分の使い方に合わせます。

  ```console
  $ for region in ap-northeast-1 ap-northeast-3 ap-southeast-2 us-east-1; do
      aws cloudformation deploy --profile admin --region "$region" \
        --template-file cfn/break-glass-notification.yaml \
        --stack-name iam-break-glass-notification
    done
  ```

- CloudTrail の証跡は、読み取りと書き込みの両方を記録するマルチリージョン証跡が 1 本あれば足ります。
- SNS トピックはリージョンごとにできます。それぞれのトピックに、デプロイのあとで宛先を登録します。通知が届くことは、定期訓練で確かめてください（本文 8.9）。

## 開発

| コマンド | 内容 |
|---|---|
| `npm test` | Jest のテストを実行します。`cfn/` が古いと失敗します |
| `npm run typecheck` | 型を検査します |
| `npm run synth` | 全スタックを合成します。AWS アカウントは要りません |
| `npm run cfn` | 合成して `cfn/` を作り直します |
| `npm run validate` | `cfn/` のポリシーを Policy Validation にかけます |

## ライセンス

テンプレートは [MIT-0](LICENSE) です。著作権表示なしで、コピーして自由に使えます。

## 正誤表とフィードバック

誤植や事実誤認の報告、改訂のアイデアは [Issue](https://github.com/takuros/aws-iam-v2-support/issues) でお知らせください。

### 正誤表

| 箇所 | 内容 |
|---|---|
| 6.3、6.6（`role/agent-*` と path） | 6.3 のとおり環境を path で表すと、`role/dev/agent-x` のような IAM ロールは 6.6 の `role/agent-*` に一致しません。path を使う場合は、`role/*/agent-*` のように path を含めて指定するか、AI 専用の IAM ロールは path なしで作ってください。 |
