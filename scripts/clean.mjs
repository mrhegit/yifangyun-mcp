import { rm } from "node:fs/promises";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  throw new Error("Pass at least one generated directory to clean.");
}

for (const target of targets) {
  if (!/^(dist|dist-test)$/.test(target)) {
    throw new Error(`Refusing to clean unexpected path: ${target}`);
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}
