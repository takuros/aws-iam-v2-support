import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  AgentAssumeAndPassPolicy,
  AiAgentRole,
  AiAgentRoleProps,
  DenyDestructiveViaMcpPolicy,
} from "../lib/ai-agent-role";

const build = (props: AiAgentRoleProps = { trustedUserNames: ["example-signin-user"] }) => {
  const stack = new Stack(new App(), "Test");
  new AiAgentRole(stack, "Agent", props);
  return Template.fromStack(stack);
};

describe("AiAgentRole", () => {
  test("is named agent-* and requires MFA by default", () => {
    build().hasResourceProperties("AWS::IAM::Role", {
      RoleName: "agent-assistant-readonly",
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Statement: [Match.objectLike({ Condition: { Bool: { "aws:MultiFactorAuthPresent": "true" } } })],
      },
    });
  });

  test("rejects a name outside agent-*", () => {
    expect(() => build({ roleName: "human-agent", trustedUserNames: ["example-signin-user"] })).toThrow(
      "must start with agent-",
    );
  });

  test("needs someone to trust", () => {
    expect(() => build({})).toThrow("Specify trustedUserNames or trustedRoleArns");
  });

  test("can be assumed by a base role without MFA", () => {
    const arn = "arn:aws:iam::123456789012:role/agent-base";
    build({ trustedRoleArns: [arn], requireMfa: false }).hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [Match.objectLike({ Principal: { AWS: arn }, Condition: Match.absent() })],
      },
    });
  });

  test("denies destructive actions without conditions, so the deny also covers direct calls", () => {
    build().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Effect: "Deny",
            Action: Match.arrayWith(["dynamodb:DeleteTable", "s3:DeleteBucket", "s3:DeleteObject"]),
            Resource: "*",
            Condition: Match.absent(),
          }),
        ],
      },
    });
  });

  test("two agent roles do not collide on policy names", () => {
    const stack = new Stack(new App(), "Test");
    for (const roleName of ["agent-a-readonly", "agent-b-readonly"]) {
      new AiAgentRole(stack, roleName, {
        roleName,
        trustedUserNames: ["example-signin-user"],
        bedrock: {},
        secretNamePrefix: "myapp",
      });
    }
    const names = Object.values(Template.fromStack(stack).findResources("AWS::IAM::ManagedPolicy")).map(
      (policy) => policy.Properties.ManagedPolicyName,
    );
    expect(new Set(names).size).toBe(4);
  });

  test("billing is denied only when ReadOnlyAccess is chosen", () => {
    const deny = {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Sid: "DenyBillingAccess", Effect: "Deny" })]) },
    };
    expect(Object.keys(build().findResources("AWS::IAM::Policy", deny))).toHaveLength(0);
    build({ trustedUserNames: ["example-signin-user"], readPolicyName: "ReadOnlyAccess" }).hasResourceProperties(
      "AWS::IAM::Policy",
      deny,
    );
  });

  test("the role has no Allow of sts:AssumeRole", () => {
    const statements = Object.values(build().findResources("AWS::IAM::Policy")).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement,
    );
    expect(statements.filter((statement) => statement.Effect === "Allow")).toEqual([]);
  });

  test("Bedrock and Secrets Manager are opt-in", () => {
    build().resourceCountIs("AWS::IAM::ManagedPolicy", 0);
  });

  test("Bedrock allows the profile and the model in each destination Region", () => {
    const inferenceProfiles = {
      "Fn::Sub":
        "arn:${AWS::Partition}:bedrock:ap-northeast-1:${AWS::AccountId}:inference-profile/jp.anthropic.claude-*",
    };
    build({ trustedUserNames: ["example-signin-user"], bedrock: {} }).hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "agent-assistant-readonly-bedrock-invoke",
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Sid: "InvokeInferenceProfiles",
            Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
            Resource: inferenceProfiles,
            Condition: Match.absent(),
          }),
          Match.objectLike({
            Sid: "InvokeModelsThroughInferenceProfiles",
            Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
            Resource: [
              { "Fn::Sub": "arn:${AWS::Partition}:bedrock:ap-northeast-1::foundation-model/anthropic.claude-*" },
              { "Fn::Sub": "arn:${AWS::Partition}:bedrock:ap-northeast-3::foundation-model/anthropic.claude-*" },
            ],
            // この条件がないと、大阪の model をモデル ID で直接呼べてしまいます
            Condition: { ArnLike: { "bedrock:InferenceProfileArn": inferenceProfiles } },
          }),
        ],
      },
    });
  });

  test("Secrets Manager allows only reads under the prefix", () => {
    build({ trustedUserNames: ["example-signin-user"], secretNamePrefix: "myapp" }).hasResourceProperties(
      "AWS::IAM::ManagedPolicy",
      {
        ManagedPolicyName: "agent-assistant-readonly-secrets-read",
        PolicyDocument: {
          Statement: [
            Match.objectLike({
              Action: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"],
              Resource: {
                "Fn::Sub": "arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:myapp/*",
              },
            }),
          ],
        },
      },
    );
  });
});

describe("AgentAssumeAndPassPolicy", () => {
  test("limits both actions to role/agent-* and PassRole to two services", () => {
    const stack = new Stack(new App(), "Test");
    new AgentAssumeAndPassPolicy(stack, "Policy");
    const agentRoles = { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/agent-*" };
    Template.fromStack(stack).hasResourceProperties("AWS::IAM::ManagedPolicy", {
      PolicyDocument: {
        Statement: [
          Match.objectLike({ Sid: "AssumeAgentRoles", Action: "sts:AssumeRole", Resource: agentRoles }),
          Match.objectLike({
            Sid: "PassAgentRolesToServices",
            Action: "iam:PassRole",
            Resource: agentRoles,
            Condition: {
              StringEquals: {
                "iam:PassedToService": ["lambda.amazonaws.com", "bedrock-agentcore.amazonaws.com"],
              },
            },
          }),
        ],
      },
    });
  });
});

describe("DenyDestructiveViaMcpPolicy", () => {
  test("denies only calls through AWS managed MCP services", () => {
    const stack = new Stack(new App(), "Test");
    new DenyDestructiveViaMcpPolicy(stack, "Policy");
    Template.fromStack(stack).hasResourceProperties("AWS::IAM::ManagedPolicy", {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:ViaAWSMCPService": "true" } },
          }),
        ],
      },
    });
  });
});
