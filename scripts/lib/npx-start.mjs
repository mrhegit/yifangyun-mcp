/**
 * start-npx.mjs 的可测纯逻辑：参数解析、env 加载合并、包说明符校验、探测 URL、npx 启动解析。
 * 解析范围为最小 KEY=VALUE 子集（非完整 dotenv）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @param {string[]} argv
 * @param {{ defaultPackage: string }} defaults
 */
export function parseArgs(argv, defaults) {
  /** @type {{ envFile?: string, packageSpec: string, help: boolean }} */
  const result = { packageSpec: defaults.defaultPackage, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      result.help = true;
      continue;
    }
    if (arg === "-e" || arg === "--env-file") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} 需要一个文件路径参数。`);
      }
      result.envFile = value;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      const value = arg.slice("--env-file=".length);
      if (!value) throw new Error("--env-file= 需要一个文件路径。");
      result.envFile = value;
      continue;
    }
    if (arg === "-p" || arg === "--package") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} 需要一个包说明符，例如 yifangyun-mcp-server@1.1.0-beta.3。`);
      }
      result.packageSpec = value;
      continue;
    }
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      if (!value) throw new Error("--package= 需要一个包说明符。");
      result.packageSpec = value;
      continue;
    }
    throw new Error(`未知参数: ${arg}（使用 --help 查看用法）`);
  }
  assertSafePackageSpec(result.packageSpec);
  return result;
}

/**
 * 仅允许常见 npm 包说明符，拒绝 shell 元字符。
 * 例：name、name@1.2.3、@scope/name@1.2.3-beta.1
 * @param {string} spec
 */
export function assertSafePackageSpec(spec) {
  if (typeof spec !== "string" || !spec.trim()) {
    throw new Error("包说明符不能为空。");
  }
  if (/[\s;&|<>^%$`'"\\!\n\r\t]/.test(spec) || spec.includes("..")) {
    throw new Error(`不安全的包说明符: ${spec}`);
  }
  // name | name@version | @scope/name | @scope/name@version
  const ok =
    /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+(?:@[A-Za-z0-9._~+-]+)?$/.test(spec);
  if (!ok) {
    throw new Error(
      `非法包说明符: ${spec}（期望 name、name@version 或 @scope/name@version）`
    );
  }
}

/**
 * 解析 KEY=VALUE 环境文件（# 整行注释、export 前缀、引号值、未引号行内 # 注释）。
 * @param {string} content
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
export function parseEnvFile(content, filePath) {
  const text = content.replace(/^\uFEFF/, "");
  /** @type {Record<string, string>} */
  const parsed = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trim();
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      throw new Error(`${filePath}:${index + 1} 无法解析: ${lines[index]}`);
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${filePath}:${index + 1} 非法变量名: ${key}`);
    }
    // 先裁未闭合引号场景下的行内注释，再剥对称引号，避免 `KEY="v" # c` 残留引号
    const hashMatch = value.match(/\s+#/);
    if (hashMatch && hashMatch.index !== undefined) {
      const before = value.slice(0, hashMatch.index);
      const dq = (before.match(/"/g) || []).length;
      const sq = (before.match(/'/g) || []).length;
      // 仅当 # 不在未闭合引号内时裁剪（偶数个引号视为已闭合）
      if (dq % 2 === 0 && sq % 2 === 0) {
        value = before.trimEnd();
      }
    }
    const doubleQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2;
    const singleQuoted = value.startsWith("'") && value.endsWith("'") && value.length >= 2;
    if (doubleQuoted || singleQuoted) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

/**
 * 合并环境：文件仅填充进程中缺失或空字符串的键。
 * （空串视为「未有效配置」，允许文件补全；非空进程值优先。）
 * @param {NodeJS.ProcessEnv} base
 * @param {Record<string, string>} fromFile
 * @returns {NodeJS.ProcessEnv}
 */
export function mergeEnv(base, fromFile) {
  /** @type {NodeJS.ProcessEnv} */
  const merged = { ...base };
  for (const [key, value] of Object.entries(fromFile)) {
    const current = merged[key];
    if (current === undefined || current === "") {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * 将监听地址映射为适合本机 curl 的探测主机。
 * 0.0.0.0 / :: 是监听地址，不是可广告客户端主机名。
 * @param {string} listenHost
 */
export function probeHostForHealth(listenHost) {
  const host = (listenHost || "127.0.0.1").trim();
  if (host === "0.0.0.0" || host === "*") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "::1";
  return host;
}

/**
 * @param {string} listenHost
 * @param {string} port
 */
export function formatHealthUrl(listenHost, port) {
  const probe = probeHostForHealth(listenHost);
  const hostPart = probe.includes(":") && !probe.startsWith("[") ? `[${probe}]` : probe;
  return `http://${hostPart}:${port}/health`;
}

/**
 * @param {{ name?: string, version?: string }} pkg
 * @param {string} fallback
 */
export function defaultPackageFromPkg(pkg, fallback) {
  if (pkg && typeof pkg.name === "string" && typeof pkg.version === "string") {
    const spec = `${pkg.name}@${pkg.version}`;
    assertSafePackageSpec(spec);
    return spec;
  }
  assertSafePackageSpec(fallback);
  return fallback;
}

/**
 * 未设置 transport 时注入默认值。
 * @param {NodeJS.ProcessEnv} env
 * @param {string} fallback
 * @returns {{ env: NodeJS.ProcessEnv, injected: boolean }}
 */
export function ensureTransport(env, fallback = "http") {
  if (env.YFY_TRANSPORT === undefined || env.YFY_TRANSPORT === "") {
    return { env: { ...env, YFY_TRANSPORT: fallback }, injected: true };
  }
  return { env, injected: false };
}

/**
 * 枚举本机可能的 npx-cli.js 路径（跨 nvm / 官方安装器布局）。
 * @param {{ execPath?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string[]}
 */
export function listNpxCliCandidates(opts = {}) {
  const execPath = opts.execPath ?? process.execPath;
  const env = opts.env ?? process.env;
  const execDir = path.dirname(execPath);
  /** @type {string[]} */
  const candidates = [
    path.join(execDir, "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(execDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(execDir, "..", "lib64", "node_modules", "npm", "bin", "npx-cli.js")
  ];
  const prefixes = [env.npm_config_prefix, env.PREFIX, env.npm_config_global_prefix].filter(
    (value) => typeof value === "string" && value.length > 0
  );
  for (const prefix of prefixes) {
    candidates.push(path.join(prefix, "node_modules", "npm", "bin", "npx-cli.js"));
    candidates.push(path.join(prefix, "lib", "node_modules", "npm", "bin", "npx-cli.js"));
  }
  return [...new Set(candidates.map((item) => path.normalize(item)))];
}

/**
 * npx 工作目录：必须避开「当前仓库」目录。
 *
 * 在名为 yifangyun-mcp-server 的 package 根目录执行
 * `npx -y yifangyun-mcp-server@…` 时，npm 会与本地同名包/bin 冲突，
 * Windows 上常报「不是内部或外部命令」。在临时中立目录执行则可正常
 * 使用 npx 缓存临时拉包（仍不写入业务项目 node_modules）。
 *
 * @param {{ tmpdir?: string, dirName?: string }} [opts]
 */
export function resolveNpxRunCwd(opts = {}) {
  const tmpdir = opts.tmpdir ?? os.tmpdir();
  const dirName = opts.dirName ?? "yifangyun-mcp-npx-run";
  return path.join(tmpdir, dirName);
}

/**
 * 解析跨平台、尽量无 shell 的 npx 启动方式。
 * Windows 上不可 shell:false 直接跑 .cmd（Node 会 EINVAL），优先 node + npx-cli.js。
 * 调用方必须把 spawn 的 cwd 设为 resolveNpxRunCwd()（或其它非本仓库目录）。
 *
 * @param {string} packageSpec 已经过 assertSafePackageSpec
 * @param {{ execPath?: string, env?: NodeJS.ProcessEnv, platform?: string, existsSync?: (p: string) => boolean, cwd?: string }} [opts]
 * @returns {{ command: string, args: string[], shell: boolean, mode: string, cwd: string, npxCli?: string }}
 */
export function resolveNpxLaunch(packageSpec, opts = {}) {
  assertSafePackageSpec(packageSpec);
  const execPath = opts.execPath ?? process.execPath;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const existsSync = opts.existsSync ?? ((p) => fs.existsSync(p));
  const cwd = opts.cwd ?? resolveNpxRunCwd();

  for (const npxCli of listNpxCliCandidates({ execPath, env })) {
    if (existsSync(npxCli)) {
      return {
        command: execPath,
        args: [npxCli, "-y", packageSpec],
        shell: false,
        mode: "node-npx-cli",
        cwd,
        npxCli
      };
    }
  }

  // 找不到 npx-cli.js 时的兜底：仍禁止把未校验 spec 拼进 shell
  if (platform === "win32") {
    return {
      command: "npx.cmd",
      args: ["-y", packageSpec],
      shell: true,
      mode: "npx-cmd-shell-fallback",
      cwd
    };
  }
  return {
    command: "npx",
    args: ["-y", packageSpec],
    shell: false,
    mode: "npx-path",
    cwd
  };
}
