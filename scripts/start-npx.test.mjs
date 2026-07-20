import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafePackageSpec,
  defaultPackageFromPkg,
  ensureTransport,
  formatHealthUrl,
  listNpxCliCandidates,
  mergeEnv,
  parseArgs,
  parseEnvFile,
  probeHostForHealth,
  resolveNpxLaunch,
  resolveNpxRunCwd
} from "./lib/npx-start.mjs";

const defaults = { defaultPackage: "yifangyun-mcp-server@1.1.0-beta.3" };

test("parseArgs: 默认 package 与 --env-file", () => {
  const a = parseArgs([], defaults);
  assert.equal(a.packageSpec, defaults.defaultPackage);
  assert.equal(a.envFile, undefined);
  assert.equal(a.help, false);

  const b = parseArgs(["-e", "./http.env", "--package", "yifangyun-mcp-server@1.0.0"], defaults);
  assert.equal(b.envFile, "./http.env");
  assert.equal(b.packageSpec, "yifangyun-mcp-server@1.0.0");

  const c = parseArgs(["--env-file=C:\\a\\b.env", "--package=@scope/pkg@2.0.0"], defaults);
  assert.equal(c.envFile, "C:\\a\\b.env");
  assert.equal(c.packageSpec, "@scope/pkg@2.0.0");
});

test("parseArgs: 拒绝空 --env-file= 与危险 package", () => {
  assert.throws(() => parseArgs(["--env-file="], defaults), /需要一个文件路径/);
  assert.throws(() => parseArgs(["--package="], defaults), /需要一个包说明符/);
  assert.throws(
    () => parseArgs(["--package", "yifangyun-mcp-server@1.0.0 & calc"], defaults),
    /不安全|非法/
  );
  assert.throws(() => parseArgs(["--unknown"], defaults), /未知参数/);
});

test("assertSafePackageSpec", () => {
  assert.doesNotThrow(() => assertSafePackageSpec("yifangyun-mcp-server@1.1.0-beta.3"));
  assert.doesNotThrow(() => assertSafePackageSpec("@scope/name@1.0.0"));
  assert.throws(() => assertSafePackageSpec("foo;rm -rf /"), /不安全|非法/);
  assert.throws(() => assertSafePackageSpec("foo|bar"), /不安全|非法/);
  assert.throws(() => assertSafePackageSpec(""), /不能为空/);
});

test("parseEnvFile: BOM、export、引号、行内注释", () => {
  const content =
    "\uFEFF# comment\n" +
    "export YFY_CLIENT_ID=abc\n" +
    "YFY_HTTP_PORT=3000 # 本机\n" +
    "YFY_NOTE=\"keep # hash\"\n" +
    "YFY_TAIL=\"value\" # trailing\n" +
    "YFY_EMPTY=\n";
  const parsed = parseEnvFile(content, "test.env");
  assert.equal(parsed.YFY_CLIENT_ID, "abc");
  assert.equal(parsed.YFY_HTTP_PORT, "3000");
  assert.equal(parsed.YFY_NOTE, "keep # hash");
  assert.equal(parsed.YFY_TAIL, "value");
  assert.equal(parsed.YFY_EMPTY, "");
});

test("parseEnvFile: 非法行报错", () => {
  assert.throws(() => parseEnvFile("NOEQUALS\n", "bad.env"), /无法解析/);
  assert.throws(() => parseEnvFile("1BAD=x\n", "bad.env"), /非法变量名/);
});

test("mergeEnv: 非空进程优先；空串与缺失由文件补全", () => {
  const merged = mergeEnv(
    { KEEP: "from-shell", EMPTY: "", MISSING_ALSO: undefined },
    { KEEP: "from-file", EMPTY: "from-file", ONLY_FILE: "yes", MISSING_ALSO: "filled" }
  );
  assert.equal(merged.KEEP, "from-shell");
  assert.equal(merged.EMPTY, "from-file");
  assert.equal(merged.ONLY_FILE, "yes");
  assert.equal(merged.MISSING_ALSO, "filled");
});

test("probeHostForHealth / formatHealthUrl", () => {
  assert.equal(probeHostForHealth("0.0.0.0"), "127.0.0.1");
  assert.equal(probeHostForHealth("::"), "::1");
  assert.equal(probeHostForHealth("[::]"), "::1");
  assert.equal(probeHostForHealth("127.0.0.1"), "127.0.0.1");
  assert.equal(formatHealthUrl("0.0.0.0", "3000"), "http://127.0.0.1:3000/health");
  assert.equal(formatHealthUrl("::", "3000"), "http://[::1]:3000/health");
  assert.equal(formatHealthUrl("mcp.example.com", "443"), "http://mcp.example.com:443/health");
});

test("defaultPackageFromPkg / ensureTransport", () => {
  assert.equal(
    defaultPackageFromPkg({ name: "yifangyun-mcp-server", version: "1.1.0-beta.3" }, "x@1"),
    "yifangyun-mcp-server@1.1.0-beta.3"
  );
  assert.equal(defaultPackageFromPkg({}, "yifangyun-mcp-server@9.9.9"), "yifangyun-mcp-server@9.9.9");

  const a = ensureTransport({}, "http");
  assert.equal(a.injected, true);
  assert.equal(a.env.YFY_TRANSPORT, "http");

  const b = ensureTransport({ YFY_TRANSPORT: "stdio" }, "http");
  assert.equal(b.injected, false);
  assert.equal(b.env.YFY_TRANSPORT, "stdio");

  const c = ensureTransport({ YFY_TRANSPORT: "" }, "http");
  assert.equal(c.injected, true);
  assert.equal(c.env.YFY_TRANSPORT, "http");
});

test("resolveNpxRunCwd: 中立临时目录（避开仓库根）", () => {
  const cwd = resolveNpxRunCwd({ tmpdir: "C:\\tmp", dirName: "yfy-run" });
  assert.equal(cwd.replace(/\//g, "\\"), "C:\\tmp\\yfy-run");
  assert.notEqual(path.resolve(cwd), path.resolve("."));

  // 默认 tmpdir 解析结果不得落在本仓库根目录内
  const real = path.resolve(resolveNpxRunCwd());
  const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const realNorm = real.toLowerCase();
  const repoNorm = repoRoot.toLowerCase();
  assert.ok(
    realNorm !== repoNorm && !realNorm.startsWith(repoNorm + path.sep.toLowerCase()),
    `npx cwd 不得位于仓库内: cwd=${real} repo=${repoRoot}`
  );
});

test("resolveNpxLaunch: 优先 node + npx-cli.js 且 shell:false，并带中立 cwd", () => {
  const candidates = listNpxCliCandidates({ execPath: process.execPath, env: {} });
  assert.ok(candidates.length >= 1);
  const chosen = candidates[0];
  const neutral = resolveNpxRunCwd({ tmpdir: "/var/tmp", dirName: "npx-run" });
  const hit = resolveNpxLaunch("pkg@1.0.0", {
    execPath: process.execPath,
    existsSync: (p) => p === chosen,
    platform: "win32",
    cwd: neutral
  });
  assert.equal(hit.mode, "node-npx-cli");
  assert.equal(hit.shell, false);
  assert.equal(hit.command, process.execPath);
  assert.equal(hit.cwd, neutral);
  assert.deepEqual(hit.args, [chosen, "-y", "pkg@1.0.0"]);
});

test("resolveNpxLaunch: Windows 无 cli 时 shell 回退且拒绝危险 spec", () => {
  const launch = resolveNpxLaunch("yifangyun-mcp-server@1.0.0", {
    existsSync: () => false,
    platform: "win32",
    cwd: "C:\\neutral"
  });
  assert.equal(launch.mode, "npx-cmd-shell-fallback");
  assert.equal(launch.shell, true);
  assert.equal(launch.command, "npx.cmd");
  assert.equal(launch.cwd, "C:\\neutral");
  assert.deepEqual(launch.args, ["-y", "yifangyun-mcp-server@1.0.0"]);
  assert.throws(
    () =>
      resolveNpxLaunch("evil@1.0.0 & calc", {
        existsSync: () => false,
        platform: "win32"
      }),
    /不安全|非法/
  );
});

test("resolveNpxLaunch: 本机可 spawn 当前 node+npx-cli --version", async () => {
  const launch = resolveNpxLaunch("yifangyun-mcp-server@1.1.0-beta.3");
  if (launch.mode !== "node-npx-cli") {
    // 极简环境无 npm 布局时跳过集成冒烟
    return;
  }
  const code = await new Promise((resolve, reject) => {
    const child = spawn(launch.command, [launch.npxCli, "--version"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  assert.equal(code, 0);
});
