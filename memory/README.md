# 观潮双层记忆

`memory/operations` 保存脱敏后的工具链、本机工程与故障经验；默认不进入 Writer 上下文。

`memory/editorial` 保存可复用的编辑判断、开放线程、政策/国家资本观察、预测回看和文章索引。原始文章、原始 provider payload 与 production ledger 不复制到记忆层。

公开记忆只使用 `${GUANCHAO_HOME}`、`${REPO_ROOT}`、`${RUNTIME_ROOT}` 等占位路径。Memory Manager 的顺序固定为：validate → dedupe → sanitize → merge；缺少 evidence 或触发敏感信息时 fail closed。
