import { createHash } from "node:crypto";

/**
 * The automation config is a text identity, not a worktree-byte identity.
 * Git/runtime checkouts may use different line-ending settings, so normalize
 * CRLF and legacy CR to LF before calculating the state hash.
 */
export function normalizeAutomationConfigBytes(bytes) {
  const text = Buffer.from(bytes).toString("utf8").replace(/\r\n?/g, "\n");
  return Buffer.from(text, "utf8");
}

export function sha256AutomationConfigBytes(bytes) {
  return createHash("sha256").update(normalizeAutomationConfigBytes(bytes)).digest("hex");
}
