# 脱敏工具链画像

- Windows 工程默认使用短路径隔离 worktree；项目根目录使用 `${REPO_ROOT}` 表示。
- Node、pnpm 使用已验证的本机稳定运行时；Python 使用 `uv run --no-project --python 3.12 python`。
- 外部运行缓存、恢复包和私有 provider 标准化缓存使用 `${RUNTIME_ROOT}` 表示，不进入公开仓库。
- 观潮本机 Writer 只使用已登录的本地 Codex；不设置外部 LLM API、token、cookie 或授权头。
