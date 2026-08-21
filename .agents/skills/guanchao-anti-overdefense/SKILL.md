---
name: guanchao-anti-overdefense
description: Prevent coding agents from turning Guanchao engineering work into excessive hashing, edge-case hardening, review machinery, or speculative scaffolding, while preserving all explicitly required Guanchao invariants, immutable identities, security work, migrations, and final validation gates.
---

# Guanchao Anti-OverDefense Skill

Use this skill for Guanchao implementation, review, refactoring, CI/validation planning, packaging, handoff, data-pipeline work, and Codex task execution.

Its purpose is simple:

> Find real problems aggressively, but keep the proposed fix proportionate to the real Guanchao requirement.

This skill adapts HERO's six anti-overdefense principles to Guanchao's existing architecture. It does **not** weaken project invariants. It specifically prevents optional uncertainty-reduction work from silently becoming the main task.

## 0. Guanchao rules that this skill must never weaken

The following remain authoritative when they are present in the current project docs, ADRs, task card, or user instruction:

- Facts before interpretation; data before model.
- `null` is not `0`.
- No default 50% probability.
- Evidence/observation scores are never probabilities.
- Models without out-of-sample edge must abstain.
- Prediction history is immutable; evaluation/revision are separate events.
- AI must not alter raw facts, probabilities, rankings, realized returns, publication status, or model version.
- Model promotion is a separate reviewed decision.
- Current dataset identity/content-addressing rules remain intact.
- Windows-first remains the default local engineering scope unless a real deployment path requires otherwise.
- Required final gates in the current task/project conventions still run. A required test, migration, review, or security control is part of the task, not “over-defense.”

If this skill conflicts with a newer accepted ADR, current `HANDOFF.md`, current `ARCHITECTURE.md`, the task card, or an explicit user instruction, the more specific/current project rule wins.

---

# 1. H — Hashing: hashes must pay rent

Do **not** add a hash, SHA-256, checksum, fingerprint, checksum manifest, signature file, or digest merely because it “improves confidence,” “adds auditability,” or “is safer.”

A new hash is justified only when **both** are true:

1. It replaces or avoids a materially more expensive operation, **or** it is already part of a real identity/integrity contract; and
2. Its result changes what the system or operator does next.

Before adding or requesting a hash, answer:

- What expensive operation or ambiguity does this hash replace?
- What code/person will actually consume the digest?
- What different branch/action happens on match vs mismatch?

If those answers are absent, do not add the hash.

## Guanchao hash allowlist

These are normally legitimate because they already serve real architecture or decision purposes:

- Content-addressed prediction/training dataset identity where dataset contents determine the dataset ID or reproducibility contract.
- Existing immutable ledger/event content identity where the current contract uses it to reject same-identity/different-content writes.
- Production model artifact identity **when an existing promotion, load, comparison, or recovery path actually consumes it**.
- Digest-based cache/skip logic that avoids re-reading or reprocessing a materially large unchanged file.
- Integrity verification explicitly required by the user, an accepted ADR, a release channel, a migration, or another real external contract.
- Git commit SHA / main SHA / HEAD used to identify the engineering baseline. This is baseline identity, not a reason to generate extra checksum files.

## Default reject list

Do not create or require these unless a concrete task says otherwise:

- SHA-256 for every routine ZIP, report, screenshot, QA image, log file, temporary output, or handoff document.
- A second checksum manifest for ordinary files already tracked and reviewed through Git when no consumer reads the manifest.
- Re-hashing the same artifact several times in one task without a state-changing event between checks.
- Hashing every row/record when ordinary structured comparison directly answers the question.
- “Final verification SHA” whose value is only copied into prose and never used for a decision.
- A new checksum subsystem whose only justification is that another checksum/guard already exists.

**Rule of thumb:** if deleting the digest would not change execution, review, promotion, recovery, or reproducibility, the digest is probably theatre.

---

# 2. E — Edge cases: defend reachable reality, not theoretical possibility

Report every defect that is actually wrong in Guanchao, including rare-looking ones.

But only propose defensive engineering for an edge case when it is reachable through at least one of:

- Guanchao's documented workflow;
- its supported CLI/API/input format;
- a real provider response or real stored data;
- current Windows local operation;
- GitHub Actions/Vercel behavior that the project actually uses;
- a user-approved migration or deployment path.

Do not spend task budget on purely theoretical cases such as exotic encodings, symlink races, millisecond race windows, hypothetical hostile local users, or unused operating systems unless the project can actually reach them.

“Rare” is not the criterion. **Reachable is the criterion.**

Examples:

- A weird provider payload seen in real data: report/fix it.
- A Windows path/encoding issue reproduced by the real project: report/fix it.
- A Linux-local compatibility scenario that Guanchao does not support and no CI/deployment uses: do not build for it.
- A hypothetical adversary modifying local files when the project assumes a cooperating operator and no real threat model says otherwise: do not create a security framework for it.

---

# 3. R — Rubrics: judgment before machinery

Do not replace engineering judgment with scoring tables, giant checklists, repeated self-audits, or validators that merely re-check already settled facts.

Before running an optional check, state internally:

1. What **specific live uncertainty** can this check resolve?
2. What concrete failure class can it detect?
3. What will I do differently if it fails?

If the only answer is “it might catch something,” narrow the check or skip it.

## Required validation is not optional theatre

When the current Guanchao task/project requires directed tests, `git diff --check`, `pnpm check`, typecheck, build, model validation, ledger validation, or another explicit gate, run it at the required point.

But do not automatically add:

- a second validator that validates the first validator;
- repeated full-suite runs after no relevant code changed;
- multiple audit passes solely to increase confidence;
- a numeric review score when a direct engineering verdict is clearer;
- a second “final review” that cannot change the merge decision.

One focused review plus the required final gates is the default. Re-run only after relevant changes or when a named live uncertainty remains.

And when something is correct, say it is correct. Do not manufacture findings to make a review look productive.

---

# 4. O — Overbuild: no fortress around a small feature

Do not build speculative infrastructure for a future Guanchao that has not been requested.

Avoid, unless a real current requirement or accepted ADR demands them:

- feature flags for one-path changes;
- migration frameworks where no migration exists;
- compatibility layers for unsupported environments;
- generic provider abstractions with only one real consumer beyond what the current architecture already requires;
- wrappers around simple one-off operations;
- duplicate old/new implementations kept “for safety”;
- recovery subsystems for routine reversible edits;
- new databases, queues, object stores, services, or permission systems without a demonstrated bottleneck;
- permanent version trees for failures that are already recoverable through Git/worktrees/current project mechanisms.

Prefer the smallest implementation that satisfies the frozen contract and can be deleted or changed later.

---

# 5. Scope the fix, never suppress the finding

These rules constrain **what you propose and build**, not whether you report a real defect.

If you have evidence of a real bug, report it even when the ideal fix is small.

Do not dismiss a defect merely because it resembles a known overdefense pattern.

Conversely, do not turn a real small defect into a broad platform rewrite.

Use this sequence:

`real defect -> narrow cause -> smallest sufficient fix -> directed proof -> required final gates`

Not:

`possible defect -> new framework -> new validator -> new checksum -> new migration layer -> repeated audit`

---

# 6. Explicit project/user requirements override anti-overdefense

This skill never blocks security, hashing, migration, compatibility, review, or validation that is explicitly required by:

- the user;
- the current task card;
- current project docs;
- an accepted ADR;
- a real external API/release/deployment contract;
- an actual threat model;
- an existing data identity or immutable-history contract.

When such a requirement exists, implement it faithfully and proportionately.

Do not use “anti-overdefense” as an excuse to weaken an invariant that Guanchao intentionally chose.

---

# Guanchao execution protocol

## At task start

Read the current Git state and the project files required by the current handoff/task. Identify the task's real contract and allowed scope before proposing new infrastructure.

Treat these categories differently:

**Required** — explicitly mandated by user/project/ADR/task. Do it.

**Decision-changing** — optional, but it resolves a real live uncertainty and its result changes the next action. Do the cheapest sufficient version.

**Theatre** — produces confidence, logs, hashes, reports, compatibility, or review artifacts without changing any decision. Skip it.

Do not turn these three categories into a large scored rubric; they are a judgment aid.

## Before adding any SHA-256/checksum

Apply the hash gate:

`existing contract OR materially expensive operation avoided?`

AND

`match/mismatch changes next action?`

If either side is no, do not add it.

## Before adding a new validator/test layer

Name the still-live failure class. Scope the test to the changed consumer/path. Prefer a direct test of behavior over a second layer of meta-validation.

## Before adding compatibility or recovery code

Point to the supported workflow that reaches the case. If the path is only hypothetical, do not build it.

## At task completion

Report:

- what changed;
- the checks that were actually required or decision-changing;
- the result of those checks;
- any unresolved real risk;
- any intentionally skipped overdefense, only when it is useful to explain the scope decision.

Do **not** automatically include SHA-256 values for routine deliverables. Include a digest only when the task's real contract consumes or requires it.

---

# Ready-to-paste block for Guanchao `AGENTS.md`

Use the following as the project-level engineering constraint block. It is intentionally shorter than the full skill.

```text
=== 观潮工程范围约束：反过度防御 ===
凡是观潮里真的有问题都要报，包括罕见但经由真实数据、受支持工作流、Windows 本机、GitHub Actions 或 Vercel 可达的问题。然后把修法收在范围内：

1. 默认按观潮真实威胁模型做工程。除非用户、ADR、部署或外部契约明确要求，不为假想攻击者做安全论文式加固。明确要求的安全/迁移/验证工作不受本规则限制。

2. 不新增 hash / SHA-256 / checksum / fingerprint，除非它属于现有内容寻址/不可变身份契约，或它替代了实质上更昂贵的操作，并且 match/mismatch 会改变下一步。不要给例行 ZIP、报告、截图、日志、临时文件机械生成 SHA-256；不要为 Git 已覆盖的普通审计再造一套无人消费的 checksum manifest。

3. 不为当前不会发生的情况增加 feature flag、迁移框架、兼容层、包装层、恢复体系或第二套 old/new 实现。最小充分实现优先。

4. 边界情况以“观潮是否真实可达”为准，不以“理论上能否构造”为准。真实 provider 数据、项目文档示例、正式 CLI/API、Windows 本机、实际 CI/Vercel 可达就必须处理；纯理论编码、符号链接竞态、毫秒竞态、未支持 OS 默认不扩建防御。

5. 需要判断时直接判断，不用评分表、巨型 checklist 或反复自审代替判断。跑可选检查前必须能说明：具体要检测哪个仍然存活的不确定性？失败后下一步会怎么不同？答不上来就不要跑。项目明确要求的定向测试、pnpm check、build、账本/模型验证等最终门禁照常执行，但不要无相关改动重复跑多轮。

6. 本规则永远不能覆盖用户、最新 HANDOFF/ARCHITECTURE、accepted ADR、任务卡或外部契约明确要求的安全、迁移、验证、不可变历史、dataset identity、模型 artifact identity、发布门槛和审阅。那些是需求本身，不是过度防御。

观潮长期不变量继续成立：null != 0；无样本外优势必须 abstain；EvidenceScore 不是概率；历史预测不可改写；AI 不得修改数据、概率、排名、收益、发布状态或模型版本；重点观察不得人为加分。

对的就说对。不要为了显得严谨而制造额外检查、哈希、框架或问题。
=== 结束 ===
```

---

# Calibration examples for Guanchao

### Reject as overdefense

- “PR 完成了，再给最终 ZIP、报告、截图、日志分别算一遍 SHA-256 以提高安全性。”
- “Git 已记录全部变更，再建立一个 checksum manifest 证明这些 Markdown 没改。”
- “Windows-only 本地流程稳定，再实现一套无人使用的 Linux 本地兼容层。”
- “测试已通过且代码没变，再连续跑三遍全套验证提高置信度。”
- “一个简单 JSON 字段迁移，先搭通用 migration framework、feature flag 和兼容 adapter。”

### Keep as legitimate engineering

- Dataset 内容变化必须得到新的内容寻址 identity，否则训练可复现性和历史契约会被破坏。
- Immutable ledger 对 same-identity/different-content 写入必须失败，因为结果决定拒绝写入。
- 已有生产模型 artifact digest 被 promotion/load/recovery 流程实际读取时继续保留。
- 修改共享序列化契约后，对真实消费者运行一次定向验证，因为仍存在明确的兼容不确定性。
- accepted ADR 明确要求的迁移、安全或最终验证必须执行。

---

# Final decision principle

The optimization target is not “maximum possible certainty.”

The optimization target is:

> **Correct Guanchao behavior, with the smallest sufficient proof and the lowest long-term maintenance cost.**
