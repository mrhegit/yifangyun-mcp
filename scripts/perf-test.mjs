import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["--test", "dist/scanEngine.test.js"], {
  env: { ...process.env, YFY_RUN_PERF_TESTS: "1" },
  stdio: "inherit"
});

child.on("exit", (code) => process.exit(code ?? 1));
