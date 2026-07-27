import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collector = path.join(root, "scripts", "market_evidence.py");
const rotationRunner = path.join(root, "scripts", "run-sector-rotation.mjs");
const timestampNormalizer = path.join(root, "scripts", "normalize-market-observer-timestamps.mjs");
const userArgs = process.argv.slice(2);

if (userArgs.length === 0) {
  console.error("用法: node scripts/run-market-evidence.mjs <daily|weekly|health|test> [...参数]");
  process.exit(2);
}

const command = userArgs[0];
const skipRotation = userArgs.includes("--skip-rotation-refresh");
const collectorArgs = userArgs.filter((arg) => arg !== "--skip-rotation-refresh");

if (command === "daily" && !skipRotation) {
  const signals = spawnSync(process.execPath, [rotationRunner, "signals"], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (signals.error || signals.status !== 0) {
    console.warn(
      `港股宏观辅助信号刷新失败；继续刷新基础行情，但港股概率模型必须按数据完整度门禁弃权。${
        signals.error ? ` ${signals.error.message}` : ""
      }`,
    );
  }
  const rotation = spawnSync(process.execPath, [rotationRunner, "refresh"], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (rotation.error || rotation.status !== 0) {
    console.error(
      `结构化行业历史刷新失败；停止写入证据包，避免把旧量价标成今日数据。${
        rotation.error ? ` ${rotation.error.message}` : ""
      }`,
    );
    process.exit(rotation.status ?? 1);
  }
}

const candidates = [];
if (process.env.CODEX_PYTHON) {
  candidates.push({ command: process.env.CODEX_PYTHON, prefix: [], label: "CODEX_PYTHON" });
}
candidates.push(
  { command: "python", prefix: [], label: "python" },
  { command: "py", prefix: ["-3"], label: "py -3" },
  {
    command: "uv",
    prefix: ["run", "--no-project", "--python", "3.12", "--with", "requests", "--with", "xlrd", "python"],
    label: "uv managed Python",
  },
);

let selected = null;
for (const candidate of candidates) {
  const probe = spawnSync(
    candidate.command,
    [...candidate.prefix, "-c", "import requests,xlrd,sys; print(sys.executable)"],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  if (!probe.error && probe.status === 0) {
    selected = candidate;
    break;
  }
}

if (!selected) {
  console.error(
    "找不到可用的 Python 3 + requests + xlrd。请设置 CODEX_PYTHON，或安装 python/py/uv。",
  );
  process.exit(1);
}

const pythonArgs =
  command === "test"
    ? [...selected.prefix, "-m", "unittest", "scripts/test_market_evidence.py"]
    : [...selected.prefix, collector, ...collectorArgs];
const result = spawnSync(selected.command, pythonArgs, {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(`市场证据采集 ${selected.label} 启动失败: ${result.error.message}`);
  process.exit(1);
}
if (result.status === 0 && command === "daily") {
  const normalized = spawnSync(process.execPath, [timestampNormalizer], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (normalized.error || normalized.status !== 0) {
    console.error(`市场事实时间戳归一化失败：${normalized.error?.message ?? `exit ${normalized.status}`}`);
    process.exit(normalized.status ?? 1);
  }
}
process.exit(result.status ?? 1);
