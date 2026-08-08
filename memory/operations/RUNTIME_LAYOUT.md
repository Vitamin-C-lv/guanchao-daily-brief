# 运行布局

- 项目代码：`${REPO_ROOT}`
- 稳定运行时：`${GUANCHAO_HOME}/local-writer-runtime`
- 恢复与运行包：`${GUANCHAO_HOME}/recovery/GuanchaoWriter/runs`
- 私有行情/研究缓存：`${RUNTIME_ROOT}/market-history-cache` 与 `${RUNTIME_ROOT}/research-cache`
- 公开 memory 只保存经过 sanitize 的索引、摘要和证据引用，不保存 raw provider payload。
