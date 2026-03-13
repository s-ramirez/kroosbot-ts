import path from "node:path";
import { runEvalSuite } from "./runner.js";

async function main(): Promise<void> {
  const suiteArg = process.argv[2]?.trim();
  const suitePath = suiteArg
    ? path.resolve(suiteArg)
    : path.resolve("evals", "tool-decisions.json");

  const { suite, results } = await runEvalSuite(suitePath);
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;

  console.log(`Suite: ${suite.name}`);
  if (suite.description) {
    console.log(suite.description);
  }
  console.log(`Passed: ${passed}/${results.length}`);
  console.log(`Failed: ${failed}/${results.length}`);
  console.log("");

  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}`);
    console.log(`  tools: ${result.calledTools.length > 0 ? result.calledTools.join(", ") : "(none)"}`);
    console.log(`  answer: ${result.finalAnswer || "(empty)"}`);
    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        console.log(`  - ${failure}`);
      }
    }
    if (result.trace.length > 0) {
      for (const entry of result.trace) {
        console.log(`  trace step ${entry.step}: ${entry.toolName} [${entry.ok ? "ok" : "error"}]`);
      }
    }
    console.log("");
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("kroosbot-ts evals failed", error);
  process.exitCode = 1;
});
