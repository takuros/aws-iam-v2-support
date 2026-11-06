/**
 * cfn/ のテンプレートから IAM のポリシーを取り出し、IAM Access Analyzer の Policy Validation にかけます。
 * 対象は IAM ロールの信頼ポリシー、インラインポリシー、管理ポリシーです。
 * SNS のトピックポリシーなど、IAM 以外のリソースのポリシーは対象外です。
 * ERROR か SECURITY_WARNING が 1 件でもあれば、終了コード 1 で止まります。
 *
 *   npm run validate              AWS CLI で検証します（読み取りの API だけを呼びます）
 *   npm run validate -- --dry-run 取り出すポリシーの一覧だけを表示します（認証情報は要りません）
 *
 * ポリシーの中の疑似パラメータは、検証用の値に置き換えます。実際の値は送りません。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ACCOUNT_ID = "123456789012";
const REGION = "ap-northeast-1";

interface PolicyTarget {
  name: string;
  document: unknown;
  trustPolicy: boolean;
}

/** CloudFormation の組み込み関数を、検証用の文字列に解決します */
function resolve(value: any): any {
  if (Array.isArray(value)) return value.map(resolve);
  if (value === null || typeof value !== "object") return value;
  if (typeof value["Fn::Sub"] === "string") {
    return value["Fn::Sub"]
      .replaceAll("${AWS::Partition}", "aws")
      .replaceAll("${AWS::AccountId}", ACCOUNT_ID)
      .replaceAll("${AWS::Region}", REGION)
      .replaceAll("${!", "${");
  }
  if (value["Fn::Join"]) {
    const [separator, parts] = value["Fn::Join"];
    return resolve(parts).join(separator);
  }
  if (value.Ref) {
    if (value.Ref === "AWS::Partition") return "aws";
    if (value.Ref === "AWS::AccountId") return ACCOUNT_ID;
    if (value.Ref === "AWS::Region") return REGION;
    // テンプレート内のリソースへの参照です。形だけ正しい ARN に置き換えます
    if (/Provider/.test(value.Ref)) {
      return `arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`;
    }
    return `arn:aws:iam::${ACCOUNT_ID}:policy/${value.Ref}`;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
}

function collectPolicies(fileName: string, template: any): PolicyTarget[] {
  const targets: PolicyTarget[] = [];
  for (const [logicalId, resource] of Object.entries<any>(template.Resources ?? {})) {
    const name = `${fileName} ${logicalId}`;
    const properties = resource.Properties ?? {};
    if (resource.Type === "AWS::IAM::Role") {
      targets.push({ name: `${name} (trust)`, document: resolve(properties.AssumeRolePolicyDocument), trustPolicy: true });
    }
    if (["AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"].includes(resource.Type)) {
      targets.push({ name, document: resolve(properties.PolicyDocument), trustPolicy: false });
    }
    for (const inline of properties.Policies ?? []) {
      targets.push({ name: `${name} ${inline.PolicyName}`, document: resolve(inline.PolicyDocument), trustPolicy: false });
    }
  }
  return targets;
}

function validate(target: PolicyTarget): { findingType: string; issueCode: string; findingDetails: string }[] {
  const args = [
    "accessanalyzer",
    "validate-policy",
    "--locale",
    "JA",
    "--output",
    "json",
    "--policy-document",
    JSON.stringify(target.document),
    ...(target.trustPolicy
      ? ["--policy-type", "RESOURCE_POLICY", "--validate-policy-resource-type", "AWS::IAM::AssumeRolePolicyDocument"]
      : ["--policy-type", "IDENTITY_POLICY"]),
  ];
  // 標準入力を引き継ぐので、MFA のコードを聞かれたら答えられます
  return JSON.parse(execFileSync("aws", args, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] })).findings;
}

const dryRun = process.argv.includes("--dry-run");
const directory = join(__dirname, "..", "cfn");
const targets = readdirSync(directory)
  .filter((fileName) => fileName.endsWith(".yaml"))
  .flatMap((fileName) => collectPolicies(fileName, parse(readFileSync(join(directory, fileName), "utf8"))));

let blocking = 0;
for (const target of targets) {
  if (dryRun) {
    console.log(target.name);
    continue;
  }
  const findings = validate(target);
  console.log(`${target.name}: ${findings.length} findings`);
  for (const finding of findings) {
    console.log(`  ${finding.findingType} ${finding.issueCode}: ${finding.findingDetails}`);
    if (["ERROR", "SECURITY_WARNING"].includes(finding.findingType)) blocking += 1;
  }
}
console.log(`${targets.length} policies${dryRun ? " (dry run)" : `, ${blocking} blocking findings`}`);
process.exit(blocking > 0 ? 1 : 0);
