import { spawnSync } from "node:child_process";

function defaultCommand(command, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", windowsHide: true, timeout: 20 * 60_000 });
  const detail = (result.stderr || result.stdout || "").trim().slice(0, 2_000);
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", detail, error: result.error?.message ?? null };
}
function gitCommand(root, args, command) {
  return command("git", ["-C", root, ...args], { cwd: root, allowFailure: true });
}

function ref(root, name, command) {
  const result = gitCommand(root, ["rev-parse", name], command);
  return result.ok ? result.stdout.trim() : null;
}

export function ancestorRelation({ root, ancestor, descendant, command = defaultCommand } = {}) {
  const result = gitCommand(root, ["merge-base", "--is-ancestor", ancestor, descendant], command);
  if (result.ok) return { relation: "ancestor", detail: result.detail };
  if (result.status === 1) return { relation: "not-ancestor", detail: result.detail };
  return { relation: "unavailable", detail: result.detail || result.error || "merge-base unavailable" };
}

export function pushCurrentHeadToMain({ root, command = defaultCommand, env = process.env } = {}) {
  const currentHead = ref(root, "HEAD", command);
  if (!currentHead) return { ok: false, errorCode: "PUSH_HEAD_UNAVAILABLE", detail: "current HEAD is unavailable" };

  const beforeFetch = ref(root, "refs/remotes/origin/main", command);
  const fetchBefore = gitCommand(root, ["fetch", "origin", "main"], command);
  if (!fetchBefore.ok) return { ok: false, errorCode: "PUSH_REMOTE_FETCH_FAILED", detail: fetchBefore.detail || fetchBefore.error || "pre-push remote fetch failed", currentHead, remoteMainBeforeFetch: beforeFetch };
  const remoteMainBeforePush = ref(root, "refs/remotes/origin/main", command);
  if (!remoteMainBeforePush) return { ok: false, errorCode: "REMOTE_MAIN_UNAVAILABLE", detail: "fresh origin/main is unavailable", currentHead, remoteMainBeforeFetch: beforeFetch };

  const relation = ancestorRelation({ root, ancestor: remoteMainBeforePush, descendant: currentHead, command });
  if (relation.relation === "unavailable") return { ok: false, errorCode: "ANCESTRY_UNAVAILABLE", detail: relation.detail, currentHead, remoteMainBeforeFetch: beforeFetch, remoteMainBeforePush };
  if (relation.relation !== "ancestor") return { ok: false, errorCode: "REMOTE_DIVERGED", detail: `fresh origin/main ${remoteMainBeforePush} is not an ancestor of HEAD ${currentHead}`, currentHead, remoteMainBeforeFetch: beforeFetch, remoteMainBeforePush };

  const push = command("git", ["-C", root, "push", "origin", "HEAD:main"], { cwd: root, env, allowFailure: true });
  if (!push.ok) return { ok: false, errorCode: "PUSH_FAILED", detail: push.detail || push.error || "HEAD:main push failed", currentHead, remoteMainBeforeFetch: beforeFetch, remoteMainBeforePush };

  const fetchAfter = gitCommand(root, ["fetch", "origin", "main"], command);
  if (!fetchAfter.ok) return { ok: false, errorCode: "PUSH_POST_FETCH_FAILED", detail: fetchAfter.detail || fetchAfter.error || "post-push remote fetch failed", currentHead, remoteMainBeforeFetch: beforeFetch, remoteMainBeforePush };
  const remoteMainAfterPush = ref(root, "refs/remotes/origin/main", command);
  if (remoteMainAfterPush !== currentHead) return { ok: false, errorCode: "PUSH_NOT_CONVERGED", detail: `origin/main ${remoteMainAfterPush ?? "missing"} did not converge to HEAD ${currentHead}`, currentHead, remoteMainBeforeFetch: beforeFetch, remoteMainBeforePush, remoteMainAfterPush };
  return { ok: true, target: "HEAD:main", currentHead, remoteMainBeforeFetch: beforeFetch, remoteMainBeforePush, remoteMainAfterPush };
}
