import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

function gitCommit() {
  if (process.env.YFY_BUILD_COMMIT?.trim()) return process.env.YFY_BUILD_COMMIT.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "source-unavailable";
  }
}

function gitDirty() {
  if (process.env.YFY_BUILD_COMMIT?.trim()) return false;
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

const commit = gitCommit();
const dirtySuffix = gitDirty() ? ".dirty" : "";
const buildId = process.env.YFY_BUILD_ID?.trim() || `${packageJson.version}+${commit.slice(0, 12)}${dirtySuffix}`;
const target = path.join(root, "src", ".generated", "buildInfo.ts");
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, [
  "// 构建期生成；不要手工修改。",
  `export const GENERATED_BUILD_ID = ${JSON.stringify(buildId)};`,
  `export const GENERATED_BUILD_COMMIT = ${JSON.stringify(commit)};`,
  ""
].join("\n"), "utf8");
