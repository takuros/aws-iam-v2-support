/**
 * 差し替える値は、このファイルにまとめてあります。
 * アカウント ID は書きません。デプロイ先のアカウントがテンプレートに入ります。
 */
export const settings = {
  /** 各ロールに切り替えてよいサインイン用 IAM ユーザー。先に作ってある名前に替えます */
  trustedUsers: {
    admin: ["example-signin-user"],
    developer: ["example-signin-user"],
    operator: ["example-signin-user"],
    auditor: ["example-signin-user"],
    billing: ["example-signin-user"],
    agent: ["example-signin-user"],
  },

  /** ブレイクグラス用 IAM ユーザー。単一アカウントで作らないなら空の配列にします */
  breakGlassUsers: ["bg-member1", "bg-member2"],

  /** 本文の命名規則（<役割接頭辞>-<用途>-<粒度の接尾辞>）にそろえたロール名 */
  roleNames: {
    admin: "human-account-admin",
    developer: "human-developer-readwrite",
    developerNoBoundary: "human-developer-simple-readwrite",
    operator: "human-operator-readwrite",
    auditor: "human-auditor-readonly",
    billing: "human-billing-readonly",
    githubDeploy: "ci-deploy-readwrite",
    agent: "agent-assistant-readonly",
  },

  github: {
    owner: "my-org",
    repository: "my-repo",
    branch: "main",
    deployBucketName: "example-deploy-bucket",
    resourceNamePrefix: "example-app-",
    /**
     * 本文 7.7 の手順で OIDC Provider を登録済みなら、その ARN を書きます。
     * 例: "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
     */
    oidcProviderArn: undefined as string | undefined,
  },

  /** AI エージェントに読ませるシークレットの名前の接頭辞 */
  agentSecretNamePrefix: "myapp",
};
