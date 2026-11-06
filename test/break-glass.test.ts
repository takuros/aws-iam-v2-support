import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BreakGlass, BreakGlassNotification } from "../lib/break-glass";

const build = (userNames = ["bg-member1", "bg-member2"]) => {
  const stack = new Stack(new App(), "Test");
  new BreakGlass(stack, "BreakGlass", { userNames, adminRoleName: "human-account-admin" });
  return Template.fromStack(stack);
};

describe("BreakGlass", () => {
  test("creates one user per person in the break-glass group", () => {
    const template = build();
    template.resourceCountIs("AWS::IAM::User", 2);
    template.hasResourceProperties("AWS::IAM::Group", { GroupName: "break-glass" });
    template.hasResourceProperties("AWS::IAM::User", { UserName: "bg-member1", Groups: [Match.anyValue()] });
  });

  test("has no access keys or passwords in code", () => {
    const template = build();
    template.resourceCountIs("AWS::IAM::AccessKey", 0);
    template.hasResourceProperties("AWS::IAM::User", { LoginProfile: Match.absent() });
  });

  test("rejects a name that the notification would miss", () => {
    expect(() => build(["member1"])).toThrow("must start with bg-");
  });

  test("group can only assume the admin role and manage its own MFA and password", () => {
    const template = build();
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Sid: "AllowAssumeAdminRole",
            Action: "sts:AssumeRole",
            Resource: { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/human-account-admin" },
          }),
          Match.objectLike({
            Sid: "AllowSelfManageMFAandPassword",
            Resource: [
              { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:user/${!aws:username}" },
              { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:mfa/${!aws:username}" },
            ],
          }),
        ],
      },
    });
    template.hasResourceProperties("AWS::IAM::Group", { ManagedPolicyArns: Match.absent() });
  });

  test("does not allow aws login or creating access keys", () => {
    const statements = Object.values(build().findResources("AWS::IAM::Policy")).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement,
    );
    const actions = statements.flatMap((statement) => [statement.Action].flat());
    expect(actions.filter((action) => action.startsWith("signin:"))).toEqual([]);
    expect(actions).not.toContain("iam:CreateAccessKey");
  });
});

describe("BreakGlassNotification", () => {
  const build = () => {
    const stack = new Stack(new App(), "Test");
    new BreakGlassNotification(stack, "Notification");
    return Template.fromStack(stack);
  };

  test("catches successful console sign-in of bg- users", () => {
    build().hasResourceProperties("AWS::Events::Rule", {
      State: "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS",
      EventPattern: {
        detail: {
          eventName: ["ConsoleLogin"],
          userIdentity: { arn: [{ wildcard: "*:user/bg-*" }] },
          responseElements: { ConsoleLogin: ["Success"] },
        },
      },
    });
  });

  test("catches both aws login events", () => {
    build().hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        detail: Match.objectLike({ eventName: ["AuthorizeOAuth2Access", "CreateOAuth2Token"] }),
      },
    });
  });
});
