import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");

const result = spawnSync(
  process.execPath,
  [tsxCliPath, "--test", "src/governance/__tests__/governance-postgres-integration.test.ts"],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEEPRUN_GOVERNANCE_INTEGRATION_REQUIRE_DB: "true"
    },
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"]
  }
);

if (result.error) {
  throw result.error;
}

if (result.stdout) {
  process.stdout.write(result.stdout);
}

if (result.stderr) {
  process.stderr.write(result.stderr);
}

const output = `${result.stdout || ""}\n${result.stderr || ""}`;
const summaryValue = (name) => {
  const match = output.match(new RegExp(`^(?:#|\\u2139) ${name} (\\d+)\\s*$`, "im"));
  return match ? Number(match[1]) : null;
};

const reportedTests = summaryValue("tests");
const passedTests = summaryValue("pass");
const skippedTests = summaryValue("skipped") ?? 0;

if ((result.status ?? 1) === 0) {
  if (reportedTests === null || passedTests === null) {
    process.stderr.write("[governance-integration-ci] failed to read node:test summary; refusing to accept the run.\n");
    process.exit(1);
  }

  if (reportedTests <= 0 || passedTests <= 0 || skippedTests > 0) {
    process.stderr.write(
      `[governance-integration-ci] expected a non-skipped Postgres run; reported tests=${reportedTests}, pass=${passedTests}, skipped=${skippedTests}.\n`
    );
    process.exit(1);
  }

  process.stderr.write(`Executed governance integration tests: ${passedTests}\n`);
  process.stderr.write(
    `[governance-integration-ci] reported tests=${reportedTests}, pass=${passedTests}, skipped=${skippedTests}.\n`
  );
}

process.exit(result.status ?? 1);
