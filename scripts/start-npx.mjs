#!/usr/bin/env node
/**
 * 跨平台（Windows / macOS / Linux）通过 npx 启动 yifangyun-mcp-server。
 *
 * 环境文件优先级：
 *   1. 命令行 --env-file / -e（最高）
 *   2. 脚本同目录下的 .env
 *
 * 键值合并：
 *   - 进程中已有非空变量优先于文件
 *   - 进程中缺失或空字符串可由文件补全
 *
 * 用法：
 *   node scripts/start-npx.mjs
 *   node scripts/start-npx.mjs --env-file ./http.prod.env
 *   npm run start:http:npx -- --env-file C:\path\to\http.env
 *
 * 说明：
 * - 本脚本在仓库中提供；npm 全局安装包不会附带该脚本
 * - 默认面向 HTTP：若未配置 YFY_TRANSPORT，则注入 http
 * - 默认包版本读取仓库 package.json 的 name@version
 * - npx 在临时中立目录执行（避免在本仓库根目录与同名 package 冲突）
 * - 仍用 npx 临时缓存，不向业务项目写入 node_modules
 * - 需本机 Node.js >= 24 与可用的 npm/npx
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafePackageSpec,
  defaultPackageFromPkg,
  ensureTransport,
  formatHealthUrl,
  mergeEnv,
  parseArgs,
  parseEnvFile,
  resolveNpxLaunch,
  resolveNpxRunCwd
} from "./lib/npx-start.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_FILE = path.join(SCRIPT_DIR, ".env");
const PACKAGE_JSON_PATH = path.join(SCRIPT_DIR, "..", "package.json");
const FALLBACK_PACKAGE = "yifangyun-mcp-server@1.1.0-beta.3";

function readDefaultPackage() {
  try {
    const raw = fs.readFileSync(PACKAGE_JSON_PATH, "utf8").replace(/^\uFEFF/, "");
    const pkg = JSON.parse(raw);
    return defaultPackageFromPkg(pkg, FALLBACK_PACKAGE);
  } catch {
    return FALLBACK_PACKAGE;
  }
}

const DEFAULT_PACKAGE = readDefaultPackage();

function printHelp() {
  const text = `
用法: node scripts/start-npx.mjs [选项]

通过 npx 拉取并启动发布包（无需本地业务目录 npm install / 构建源码）。
需检出本仓库以使用本脚本（不随 npm 全局包分发）。

选项:
  -e, --env-file <path>   指定环境变量文件（优先级高于脚本同目录 .env）
  -p, --package <spec>    npm 包说明符（默认: ${DEFAULT_PACKAGE}）
  -h, --help              显示帮助

环境文件:
  默认读取: ${DEFAULT_ENV_FILE}
  可用参数覆盖: --env-file /path/to/http.env
  合并: 进程非空变量优先；缺失或空串可由文件补全
  格式: 最小 KEY=VALUE（# 整行注释；未引号值支持行内 # 注释；UTF-8 BOM 可识别）

HTTP 最小示例（写入 env 文件）:
  YFY_CLIENT_ID=...
  YFY_CLIENT_SECRET=...
  YFY_ENTERPRISE_ID=115
  YFY_DEFAULT_USER_ID=530
  YFY_TRANSPORT=http
  YFY_HTTP_HOST=127.0.0.1
  YFY_HTTP_PORT=3000

示例:
  node scripts/start-npx.mjs
  node scripts/start-npx.mjs -e ./http.env
  node scripts/start-npx.mjs --env-file /etc/yifangyun-mcp/env --package yifangyun-mcp-server@1.1.0-beta.3
`.trim();
  console.log(text);
}

/**
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function loadEnvFile(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`环境文件不存在: ${absolute}`);
  }
  if (!fs.statSync(absolute).isFile()) {
    throw new Error(`环境路径不是文件: ${absolute}`);
  }
  const content = fs.readFileSync(absolute, "utf8");
  return parseEnvFile(content, absolute);
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals | number} signal
 */
function terminateChild(child, signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // 清理 npx 拉起的孙进程，避免端口占用
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      shell: false
    });
    let err = "";
    killer.stderr?.on("data", (chunk) => {
      err += String(chunk);
    });
    killer.on("exit", (code) => {
      if (code && code !== 0 && err.trim()) {
        console.error(`[start-npx] taskkill 未完全成功 (exit ${code})，若端口仍占用请手动结束 node 进程。`);
      }
    });
    return;
  }
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

/**
 * @param {string} packageSpec
 * @param {NodeJS.ProcessEnv} env
 */
function runNpx(packageSpec, env) {
  assertSafePackageSpec(packageSpec);
  // 必须在仓库外目录跑 npx：仓库 package.name 与发布包同名时，
  // Windows 上会出现「yifangyun-mcp-server 不是内部或外部命令」。
  const cwd = resolveNpxRunCwd();
  fs.mkdirSync(cwd, { recursive: true });
  const launch = resolveNpxLaunch(packageSpec, { cwd });
  if (launch.mode === "npx-cmd-shell-fallback") {
    console.error("[start-npx] 未找到 npx-cli.js，Windows 回退 shell 启动（包说明符已校验）。");
  } else if (launch.npxCli) {
    console.error(`[start-npx] npx-cli: ${launch.npxCli}`);
  }
  console.error(
    `[start-npx] npx cwd: ${launch.cwd}（中立目录，避免与本仓库同名包冲突；npx 临时缓存，不写入项目 node_modules）`
  );

  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env,
    stdio: "inherit",
    shell: launch.shell,
    windowsHide: true
  });

  let shuttingDown = false;
  const forward = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    terminateChild(child, signal);
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));

  child.on("error", (error) => {
    const code = "code" in error && typeof error.code === "string" ? error.code : "";
    console.error(`启动 npx 失败: ${error.message}${code ? ` (${code})` : ""}`);
    if (code === "EINVAL") {
      console.error("Windows 上请确保通过 node + npx-cli.js 启动；勿对 .cmd 使用 shell:false。");
    } else if (code === "ENOENT") {
      console.error("请确认本机已安装 Node.js >= 24，且 npm/npx 在 PATH 中。");
    } else {
      console.error("请确认本机已安装 Node.js >= 24，且 npm/npx 可用。");
    }
    if (process.platform === "win32") {
      console.error("若端口仍占用，可手动结束残留 node 进程。");
    }
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
      return;
    }
    process.exit(code ?? 1);
  });
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), { defaultPackage: DEFAULT_PACKAGE });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const envFilePath = options.envFile
    ? path.resolve(options.envFile)
    : DEFAULT_ENV_FILE;
  const fromCli = Boolean(options.envFile);

  if (!fs.existsSync(envFilePath)) {
    console.error(
      fromCli
        ? `指定的环境文件不存在: ${envFilePath}`
        : `未找到默认环境文件: ${envFilePath}`
    );
    console.error("");
    console.error("处理方式：");
    console.error("  1. 在脚本同目录创建 .env（可参考 scripts/http.env.example）");
    console.error("  2. 或用参数指定: node scripts/start-npx.mjs --env-file <path>");
    console.error("");
    console.error("HTTP 最小变量见: node scripts/start-npx.mjs --help");
    process.exit(1);
  }

  let fileEnv;
  try {
    fileEnv = loadEnvFile(envFilePath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  let env = mergeEnv(process.env, fileEnv);
  const transport = ensureTransport(env, "http");
  env = transport.env;
  if (transport.injected) {
    console.error("[start-npx] 未设置 YFY_TRANSPORT，已默认使用 http。");
  }

  const listenHost = env.YFY_HTTP_HOST || "127.0.0.1";
  const port = env.YFY_HTTP_PORT || "3000";
  console.error(`[start-npx] env: ${envFilePath}${fromCli ? " (CLI)" : " (默认)"}`);
  console.error(`[start-npx] package: ${options.packageSpec}`);
  console.error(`[start-npx] transport: ${env.YFY_TRANSPORT}`);
  if (env.YFY_TRANSPORT === "http") {
    console.error(`[start-npx] listen: ${listenHost}:${port}`);
    const health = formatHealthUrl(listenHost, port);
    if (listenHost === "0.0.0.0" || listenHost === "::" || listenHost === "[::]" || listenHost === "*") {
      console.error(`[start-npx] health (本机探测): ${health}  （监听 ${listenHost}，探测改用 loopback）`);
    } else {
      console.error(`[start-npx] health: ${health}`);
    }
  }

  runNpx(options.packageSpec, env);
}

main();
