import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { GitHubActionsDeployRole, GitHubActionsDeployRoleProps } from "../lib/github-actions-deploy-role";

const baseProps: GitHubActionsDeployRoleProps = {
  owner: "my-org",
  repository: "my-repo",
  deployBucketName: "example-deploy-bucket",
  resourceNamePrefix: "example-app-",
};

const build = (props: Partial<GitHubActionsDeployRoleProps> = {}) => {
  const stack = new Stack(new App(), "Test");
  new GitHubActionsDeployRole(stack, "Deploy", { ...baseProps, ...props });
  return Template.fromStack(stack);
};

describe("GitHubActionsDeployRole", () => {
  test("trust policy pins aud and sub to one repository and branch", () => {
    build().hasResourceProperties("AWS::IAM::Role", {
      RoleName: "ci-deploy-readwrite",
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
              StringLike: {
                "token.actions.githubusercontent.com:sub": ["repo:my-org/my-repo:ref:refs/heads/main"],
              },
            },
          }),
        ],
      },
    });
  });

  test("creates the OIDC provider without a thumbprint", () => {
    const template = build();
    template.hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIdList: ["sts.amazonaws.com"],
      ThumbprintList: Match.absent(),
    });
  });

  test("reuses an existing OIDC provider", () => {
    const arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com";
    const template = build({ oidcProviderArn: arn });
    template.resourceCountIs("AWS::IAM::OIDCProvider", 0);
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Federated: arn } })] },
    });
  });

  test("accepts the immutable sub format", () => {
    const subject = "repo:my-org@123456/my-repo@456789:ref:refs/heads/main";
    build({ subjects: [subject] }).hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: { "token.actions.githubusercontent.com:sub": [subject] },
            }),
          }),
        ],
      },
    });
  });

  test.each([
    "repo:my-org/*:ref:refs/heads/main",
    "repo:*/my-repo:ref:refs/heads/main",
    "repo:my-org/my-rep?:ref:refs/heads/main",
    "repo:my-or?/my-repo:ref:refs/heads/main",
    "repo:my-org/my-repo",
    "*",
  ])("rejects a sub that does not name one repository: %s", (subject) => {
    expect(() => build({ subjects: [subject] })).toThrow("sub must name one owner and one repository");
  });

  test("rejects an empty resource name prefix", () => {
    expect(() => build({ resourceNamePrefix: "" })).toThrow("resourceNamePrefix must not be empty");
  });

  test("permissions have no wildcard actions or resources", () => {
    const policies = build().findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        expect(statement.Resource).not.toBe("*");
        for (const action of [statement.Action].flat()) {
          expect(action).not.toContain("*");
        }
      }
    }
  });

  test("CDK bootstrap roles are opt-in", () => {
    const statement = Match.objectLike({ Sid: "AllowAssumeCdkBootstrapRoles" });
    const document = { PolicyDocument: { Statement: Match.arrayWith([statement]) } };
    expect(Object.keys(build().findResources("AWS::IAM::Policy", document))).toHaveLength(0);
    build({ allowCdkBootstrapRoles: true }).hasResourceProperties("AWS::IAM::Policy", document);
  });
});
