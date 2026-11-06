import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AdminRole } from "../lib/admin-role";
import { BillingViewerRole } from "../lib/billing-viewer-role";
import { DeveloperRole } from "../lib/developer-role";
import { OperatorRole } from "../lib/operator-role";
import { ReadOnlyRole } from "../lib/read-only-role";

const newStack = () => new Stack(new App(), "Test");
const userArn = (name: string) => ({ "Fn::Sub": `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:user/${name}` });
const mfaPresent = { Bool: { "aws:MultiFactorAuthPresent": "true" } };

function expectNoAllow(template: Template, forbidden: RegExp) {
  for (const policy of Object.values(template.findResources("AWS::IAM::Policy"))) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      if (statement.Effect !== "Allow") continue;
      for (const action of [statement.Action].flat()) {
        expect(action).not.toMatch(forbidden);
      }
    }
  }
}

describe("AdminRole", () => {
  test("requires MFA and MFA age for the named sign-in user", () => {
    const stack = newStack();
    new AdminRole(stack, "Admin", { trustedUserNames: ["example-signin-user"] });
    Template.fromStack(stack).hasResourceProperties("AWS::IAM::Role", {
      RoleName: "human-account-admin",
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { AWS: userArn("example-signin-user") },
            Condition: {
              Bool: { "aws:MultiFactorAuthPresent": "true" },
              NumericLessThan: { "aws:MultiFactorAuthAge": "3600" },
            },
          }),
        ],
      },
    });
  });

  test("keeps break-glass users in a separate statement", () => {
    const stack = newStack();
    new AdminRole(stack, "Admin", {
      trustedUserNames: ["example-signin-user"],
      breakGlassUserNames: ["bg-member1"],
    });
    Template.fromStack(stack).hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "AllowBreakGlassUsersToAssume",
            Principal: { AWS: userArn("bg-member1") },
            Condition: Match.objectLike(mfaPresent),
          }),
        ]),
      },
    });
  });
});

describe("DeveloperRole without delegation", () => {
  // 本文のリスト「IAM 書き込みが Deny されているかを確かめる CDK アプリのテスト」と同じです
  test("Developer role denies iam write actions", () => {
    const app = new App();
    const stack = new Stack(app, "Test");
    new DeveloperRole(stack, "Dev", {
      trustedAccountId: "123456789012",
      roleName: "developer-role",
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Action: Match.arrayWith(["iam:Create*", "iam:Delete*", "iam:Update*"]),
          }),
        ]),
      }),
    });
  });

  test("has no Permissions Boundary and denies billing", () => {
    const stack = newStack();
    new DeveloperRole(stack, "Dev", { roleName: "developer-role" });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::Role", { PermissionsBoundary: Match.absent() });
    template.resourceCountIs("AWS::IAM::ManagedPolicy", 0);
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "DenyBillingAccess",
            Effect: "Deny",
            Action: Match.arrayWith([
              "billing:*",
              "ce:*",
              "consolidatedbilling:*",
              "freetier:*",
              "purchase-orders:*",
              "savingsplans:*",
            ]),
          }),
        ]),
      },
    });
  });

  test("denies the CDK bootstrap roles, which would bypass the IAM deny", () => {
    const stack = newStack();
    new DeveloperRole(stack, "Dev", { roleName: "developer-role" });
    Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "DenyAssumeCdkBootstrapRoles",
            Effect: "Deny",
            Action: "sts:AssumeRole",
            Resource: { "Fn::Sub": "arn:${AWS::Partition}:iam::*:role/cdk-*" },
          }),
        ]),
      },
    });
  });

  test("requires MFA unless turned off", () => {
    const stack = newStack();
    new DeveloperRole(stack, "Dev", { roleName: "developer-role" });
    Template.fromStack(stack).hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Condition: mfaPresent })] },
    });
  });
});

describe("DeveloperRole with delegation", () => {
  const build = () => {
    const stack = newStack();
    new DeveloperRole(stack, "Dev", {
      roleName: "human-developer-readwrite",
      trustedUserNames: ["example-signin-user"],
      delegateRoleCreation: true,
    });
    return Template.fromStack(stack);
  };

  test("attaches DeveloperBoundary to the developer role", () => {
    const template = build();
    const boundaryId = Object.entries(template.findResources("AWS::IAM::ManagedPolicy")).find(
      ([, policy]) => policy.Properties.ManagedPolicyName === "DeveloperBoundary",
    )?.[0];
    template.hasResourceProperties("AWS::IAM::Role", { PermissionsBoundary: { Ref: boundaryId } });
  });

  test("DeveloperBoundary denies removing boundaries and Organizations", () => {
    build().hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "DeveloperBoundary",
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Action: Match.arrayWith([
              "iam:CreatePolicyVersion",
              "iam:DeleteRolePermissionsBoundary",
              "iam:PutRolePermissionsBoundary",
              "organizations:*",
            ]),
          }),
        ]),
      },
    });
  });

  test("DevTeamBoundary is the same as the book", () => {
    build().hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "DevTeamBoundary",
      PolicyDocument: {
        Statement: [
          Match.objectLike({ Effect: "Allow", Action: ["s3:*", "dynamodb:*", "logs:*", "lambda:*"], Resource: "*" }),
          Match.objectLike({ Effect: "Deny", Action: ["iam:*", "organizations:*", "sts:AssumeRole"], Resource: "*" }),
        ],
      },
    });
  });

  test("role creation is allowed only with DevTeamBoundary on dev-* roles", () => {
    const template = build();
    const devTeamBoundaryId = Object.entries(template.findResources("AWS::IAM::ManagedPolicy")).find(
      ([, policy]) => policy.Properties.ManagedPolicyName === "DevTeamBoundary",
    )?.[0];
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "AllowManageDevRolesWithBoundary",
            Action: Match.arrayWith(["iam:CreateRole"]),
            Resource: { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/dev-*" },
            Condition: { StringEquals: { "iam:PermissionsBoundary": { Ref: devTeamBoundaryId } } },
          }),
        ]),
      },
    });
  });

  test("does not allow changing boundaries", () => {
    expectNoAllow(build(), /^iam:(PutRolePermissionsBoundary|DeleteRolePermissionsBoundary|CreatePolicyVersion)$/);
  });

  test("no statement allows PassRole on every role", () => {
    const template = build();
    const documents = [
      ...Object.values(template.findResources("AWS::IAM::Policy")),
      ...Object.values(template.findResources("AWS::IAM::ManagedPolicy")),
    ].map((policy) => policy.Properties.PolicyDocument);
    for (const statement of documents.flatMap((document) => document.Statement)) {
      if (statement.Effect === "Allow" && [statement.Action].flat().includes("iam:PassRole")) {
        expect(statement.Resource).not.toBe("*");
      }
    }
  });

  test("PassRole is limited to dev-* roles and Lambda on both the role and the boundary", () => {
    const expected = {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "AllowPassDevRoles",
            Action: "iam:PassRole",
            Resource: { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/dev-*" },
            Condition: { StringEquals: { "iam:PassedToService": ["lambda.amazonaws.com"] } },
          }),
        ]),
      },
    };
    const template = build();
    template.hasResourceProperties("AWS::IAM::Policy", expected);
    template.hasResourceProperties("AWS::IAM::ManagedPolicy", { ManagedPolicyName: "DeveloperBoundary", ...expected });
  });

  test("the role and the boundary share the PassRole services", () => {
    const stack = newStack();
    const services = ["lambda.amazonaws.com", "ecs-tasks.amazonaws.com"];
    new DeveloperRole(stack, "Dev", {
      roleName: "human-developer-readwrite",
      delegateRoleCreation: true,
      passRoleToServices: services,
    });
    const expected = {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "AllowPassDevRoles",
            Condition: { StringEquals: { "iam:PassedToService": services } },
          }),
        ]),
      },
    };
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::Policy", expected);
    template.hasResourceProperties("AWS::IAM::ManagedPolicy", { ManagedPolicyName: "DeveloperBoundary", ...expected });
  });

  test("the boundary does not let the developer use STS to reach CDK bootstrap roles", () => {
    const boundary = Object.values(build().findResources("AWS::IAM::ManagedPolicy")).find(
      (policy) => policy.Properties.ManagedPolicyName === "DeveloperBoundary",
    );
    const allowed = boundary?.Properties.PolicyDocument.Statement.filter(
      (statement: any) => statement.Effect === "Allow",
    ).flatMap((statement: any) => [statement.Action].flat());
    expect(allowed.filter((action: string) => action.startsWith("sts:"))).toEqual([]);
  });
});

describe("OperatorRole", () => {
  test("is read-mostly and denies billing", () => {
    const stack = newStack();
    new OperatorRole(stack, "Operator", { trustedUserNames: ["example-signin-user"] });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "human-operator-readwrite",
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Condition: mfaPresent })] },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Sid: "DenyBillingAccess", Effect: "Deny" })]),
      },
    });
    expectNoAllow(template, /(\*|Delete|Terminate|Create|^sts:)/);
  });
});

describe("ReadOnlyRole", () => {
  test("has no Allow of its own and denies billing", () => {
    const stack = newStack();
    new ReadOnlyRole(stack, "ReadOnly", { trustedUserNames: ["example-signin-user"] });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "human-auditor-readonly",
      ManagedPolicyArns: [{ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::aws:policy/ReadOnlyAccess"]] }],
    });
    expectNoAllow(template, /.*/);
  });
});

describe("BillingViewerRole", () => {
  const build = () => {
    const stack = newStack();
    new BillingViewerRole(stack, "Billing", { trustedUserNames: ["example-signin-user"] });
    return Template.fromStack(stack);
  };

  test("uses the read-only managed policy, not job-function/Billing", () => {
    build().hasResourceProperties("AWS::IAM::Role", {
      ManagedPolicyArns: [
        { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::aws:policy/AWSBillingReadOnlyAccess"]] },
      ],
    });
  });

  test("adds only read actions of Cost Explorer", () => {
    const template = build();
    expectNoAllow(template, /^(?!ce:(Get|Describe|List))/);
  });
});
