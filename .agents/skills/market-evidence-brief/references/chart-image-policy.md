# Structured chart and AI visual policy

## Chart routing

- `bar`: nonnegative category-size comparison.
- `diverging-bar`: signed returns, surprises, or flows with a visible zero axis.
- `line`: 4–12 ordered time points; suitable for Stanford AI Index trends and policy paths.
- `grouped-bar`: 2–3 comparable series over the same 2–5 categories; the current mobile renderer supports at most five categories.

Every chart needs a date, unit, scope note, direct citations, finite values, and readable mobile labels. Institution forecasts must be identified as forecasts and visually distinct from observed series. Do not draw causal conclusions from correlation alone.

Use code-rendered structured values for facts. Never ask an image model to generate numbers, axes, candlesticks, report covers, logos, or evidence charts.

## Optional editorial illustration

Attempt at most one image for a daily edition and one for a weekly report, only when the selected topic is important and an abstract editorial visual adds meaning. Use the built-in image generation tool by default.

- Generate an original, restrained 16:9 finance/editorial illustration without text, numbers, logos, recognizable people, report covers, or a simulated news scene.
- Do not feed Stanford charts, publisher screenshots, or copyrighted report imagery into the image model.
- A project-bound result must have a persistent local file path. Publish it through `pnpm visual:publish -- --input <path> --date YYYY-MM-DD --slug <ascii-slug>`, then copy the returned metadata into the JSON `visual` field and add concise `alt`, `caption`, and source-array-based `basisSourceIndexes`.
- Label it “AI 生成编辑配图，仅用于主题表达，不代表真实数据或现场。” and provide meaningful alt text.
- If the tool is unavailable, returns no local path, or the asset fails validation, omit the visual and continue the report. Never put a data URL or temporary URL in JSON.

Run `pnpm assets:prune` and `pnpm validate:assets` before build. Only referenced, hashed WebP assets may be committed.
