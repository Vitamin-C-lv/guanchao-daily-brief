import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAutomationConfigBytes, sha256AutomationConfigBytes } from "./automation-config-hash.mjs";

const LF = Buffer.from('{"enabled":true,"label":"观潮"}\n', "utf8");
const CRLF = Buffer.from('{"enabled":true,"label":"观潮"}\r\n', "utf8");

test("LF and CRLF automation config bytes have the same identity", () => {
  assert.deepEqual(normalizeAutomationConfigBytes(LF), normalizeAutomationConfigBytes(CRLF));
  assert.equal(sha256AutomationConfigBytes(LF), sha256AutomationConfigBytes(CRLF));
});

test("a changed automation config still changes the identity", () => {
  const changed = Buffer.from('{"enabled":false,"label":"观潮"}\r\n', "utf8");
  assert.notEqual(sha256AutomationConfigBytes(LF), sha256AutomationConfigBytes(changed));
});

test("legacy CR is normalized with CRLF", () => {
  assert.equal(
    sha256AutomationConfigBytes(Buffer.from('{"a":1}\r{"b":2}\r', "utf8")),
    sha256AutomationConfigBytes(Buffer.from('{"a":1}\n{"b":2}\n', "utf8")),
  );
});
