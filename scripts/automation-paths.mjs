import os from "node:os";
import path from "node:path";

export const FORBIDDEN_PRODUCTION_PATH = "D:/周报个人网站";
export const DEFAULT_GUANCHAO_HOME = "D:/Guanchao-Workspace";
export const DEFAULT_RECOVERY_ROOT = "C:/Codex-Recovery/GuanchaoWriter";

function normalize(value) {
  return path.resolve(String(value).replaceAll("/", path.sep));
}

export function expandPathTemplate(value, env = process.env) {
  const input = String(value ?? "");
  const values = {
    CODEX_HOME: env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    GUANCHAO_HOME: env.GUANCHAO_HOME || DEFAULT_GUANCHAO_HOME,
    GUANCHAO_RECOVERY_ROOT: env.GUANCHAO_RECOVERY_ROOT || DEFAULT_RECOVERY_ROOT,
  };
  return input.replace(/\$\{([A-Z0-9_]+)\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`UNRESOLVED_PATH_TEMPLATE ${match}`);
    return values[key];
  });
}

export function resolveConfiguredPath(value, { env = process.env, baseDirectory = process.cwd() } = {}) {
  const expanded = expandPathTemplate(value, env);
  return path.isAbsolute(expanded) ? normalize(expanded) : normalize(path.join(baseDirectory, expanded));
}

export function resolveGuanchaoHome(env = process.env) {
  return resolveConfiguredPath(env.GUANCHAO_HOME || DEFAULT_GUANCHAO_HOME, { env });
}

export function resolveAutomationPaths({ env = process.env, homeDirectory = os.homedir() } = {}) {
  const guanchaoHome = resolveGuanchaoHome(env);
  const codexHome = resolveConfiguredPath(env.CODEX_HOME || path.join(homeDirectory, ".codex"), { env });
  const repositoryPath = path.join(guanchaoHome, "repo", "guanchao-daily-brief");
  const runtimePath = path.join(guanchaoHome, "runtime", "local-writer-runtime");
  const recoveryRoot = resolveConfiguredPath(env.GUANCHAO_RECOVERY_ROOT || DEFAULT_RECOVERY_ROOT, { env });
  return {
    guanchaoHome,
    codexHome,
    automationsRoot: path.join(codexHome, "automations"),
    repositoryPath,
    runtimePath,
    recoveryRoot,
    runsRoot: path.join(recoveryRoot, "runs"),
  };
}

export function toConfigPath(value) {
  return String(value).replaceAll("\\", "/");
}

export function isForbiddenProductionPath(value) {
  const normalized = toConfigPath(value).replace(/\/+$/, "").toLowerCase();
  const forbidden = FORBIDDEN_PRODUCTION_PATH.toLowerCase();
  return normalized === forbidden || normalized.startsWith(`${forbidden}/`);
}

export function assertAllowedProductionPath(value, label = "path") {
  if (isForbiddenProductionPath(value)) throw new Error(`FORBIDDEN_PRODUCTION_PATH ${label}: ${value}`);
  return value;
}
