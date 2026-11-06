import { App, LegacyStackSynthesizer, Stack } from "aws-cdk-lib";
import { AdminRole } from "../lib/admin-role";
import { AgentAssumeAndPassPolicy, AiAgentRole, DenyDestructiveViaMcpPolicy } from "../lib/ai-agent-role";
import { BillingViewerRole } from "../lib/billing-viewer-role";
import { BreakGlass, BreakGlassNotification } from "../lib/break-glass";
import { DeveloperRole } from "../lib/developer-role";
import { GitHubActionsDeployRole } from "../lib/github-actions-deploy-role";
import { OperatorRole } from "../lib/operator-role";
import { ReadOnlyRole } from "../lib/read-only-role";
import { settings } from "./settings";

/** スタック名と cfn/ のファイル名の対応 */
export const templateFiles: { [stackName: string]: string } = {
  IamAdminRole: "admin-role.yaml",
  IamDeveloperRole: "developer-role.yaml",
  IamDeveloperRoleNoBoundary: "developer-role-no-boundary.yaml",
  IamOperatorRole: "operator-role.yaml",
  IamReadOnlyRole: "read-only-role.yaml",
  IamBillingViewerRole: "billing-viewer-role.yaml",
  IamGitHubActionsDeployRole: "github-actions-deploy-role.yaml",
  IamAiAgentRole: "ai-agent-role.yaml",
  IamBreakGlass: "break-glass.yaml",
  IamBreakGlassNotification: "break-glass-notification.yaml",
};

export function buildApp(): App {
  const app = new App({ analyticsReporting: false });

  // env を指定しないので、cdk synth にアカウントは要りません。
  // アセットが無く、テンプレートも小さいので、bootstrap なしで CLI の認証情報からデプロイします
  const newStack = (id: string, description: string) =>
    new Stack(app, id, { description, synthesizer: new LegacyStackSynthesizer() });

  const adminStack = newStack("IamAdminRole", "Administrator role");
  new AdminRole(adminStack, "Admin", {
    roleName: settings.roleNames.admin,
    trustedUserNames: settings.trustedUsers.admin,
    breakGlassUserNames: settings.breakGlassUsers,
  });

  new DeveloperRole(newStack("IamDeveloperRole", "Developer role with Permissions Boundary"), "Developer", {
    roleName: settings.roleNames.developer,
    trustedUserNames: settings.trustedUsers.developer,
    delegateRoleCreation: true,
  });

  new DeveloperRole(newStack("IamDeveloperRoleNoBoundary", "Developer role without role creation"), "Developer", {
    roleName: settings.roleNames.developerNoBoundary,
    trustedUserNames: settings.trustedUsers.developer,
  });

  new OperatorRole(newStack("IamOperatorRole", "Operator role"), "Operator", {
    roleName: settings.roleNames.operator,
    trustedUserNames: settings.trustedUsers.operator,
  });

  new ReadOnlyRole(newStack("IamReadOnlyRole", "Read-only role"), "ReadOnly", {
    roleName: settings.roleNames.auditor,
    trustedUserNames: settings.trustedUsers.auditor,
  });

  new BillingViewerRole(newStack("IamBillingViewerRole", "Billing viewer role"), "BillingViewer", {
    roleName: settings.roleNames.billing,
    trustedUserNames: settings.trustedUsers.billing,
  });

  new GitHubActionsDeployRole(newStack("IamGitHubActionsDeployRole", "GitHub Actions deploy role"), "GitHubDeploy", {
    roleName: settings.roleNames.githubDeploy,
    ...settings.github,
  });

  const agentStack = newStack("IamAiAgentRole", "AI agent role and related policies");
  new AiAgentRole(agentStack, "Agent", {
    roleName: settings.roleNames.agent,
    trustedUserNames: settings.trustedUsers.agent,
    bedrock: {},
    secretNamePrefix: settings.agentSecretNamePrefix,
  });
  new AgentAssumeAndPassPolicy(agentStack, "AssumeAndPass");
  new DenyDestructiveViaMcpPolicy(agentStack, "DenyViaMcp");

  const breakGlassStack = newStack("IamBreakGlass", "Break-glass IAM users and group");
  new BreakGlass(breakGlassStack, "BreakGlass", {
    userNames: settings.breakGlassUsers,
    adminRoleName: settings.roleNames.admin,
  });
  // 信頼ポリシーに書く IAM ユーザーは、先に存在している必要があります
  if (settings.breakGlassUsers.length > 0) {
    adminStack.addStackDependency(breakGlassStack);
  }

  new BreakGlassNotification(
    newStack("IamBreakGlassNotification", "Notification of break-glass sign-in"),
    "Notification",
  );

  return app;
}

if (require.main === module) {
  buildApp();
}
