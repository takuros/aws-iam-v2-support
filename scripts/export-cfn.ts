/**
 * cdk.out の合成結果を、職務ごとの YAML にして cfn/ に書き出します。
 * npm run cfn で使います（cdk synth のあとに実行します）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { templateFiles } from "../bin/app";

const header = [
  "# このファイルは npm run cfn で生成しています。手で直さず、lib/ と bin/settings.ts を直して作り直します。",
  "# CloudFormation で直接デプロイするなら、example- で始まる値などを自分の値に替えます（README の「差し替える値」）。",
  "",
].join("\n");

const root = join(__dirname, "..");
mkdirSync(join(root, "cfn"), { recursive: true });

for (const [stackName, fileName] of Object.entries(templateFiles)) {
  const template = JSON.parse(readFileSync(join(root, "cdk.out", `${stackName}.template.json`), "utf8"));
  writeFileSync(join(root, "cfn", fileName), header + stringify(template, { lineWidth: 0 }));
  console.log(`cfn/${fileName}`);
}
