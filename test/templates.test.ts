import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { buildApp, templateFiles } from "../bin/app";

describe("cfn/", () => {
  // lib/ を直したのに npm run cfn を忘れたときに失敗します
  test.each(Object.entries(templateFiles))("%s is up to date", (stackName, fileName) => {
    const assembly = buildApp().synth();
    const committed = parse(readFileSync(join(__dirname, "..", "cfn", fileName), "utf8"));
    expect(committed).toEqual(assembly.getStackByName(stackName).template);
  });

  test("templates contain no account ID", () => {
    for (const fileName of Object.values(templateFiles)) {
      const text = readFileSync(join(__dirname, "..", "cfn", fileName), "utf8");
      expect(text).not.toMatch(/\b\d{12}\b/);
    }
  });
});
