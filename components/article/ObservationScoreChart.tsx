import type { ArticleVisual } from "@/lib/types";

export default function ObservationScoreChart({ visual }: { visual: ArticleVisual }) {
  const width = 640;
  const height = 300;
  const pad = { left: 96, right: 16, top: 18, bottom: 34 };
  const values = visual.points.filter((point) => point.y !== null);
  const hasData = values.length > 0;
  const yValues = values.map((point) => point.y as number);
  const yMin = hasData ? Math.min(0, ...yValues) : 0;
  const yMax = hasData ? Math.max(0, ...yValues) : 1;
  const span = yMax - yMin || 1;
  const yAt = (value: number) => pad.top + (1 - (value - yMin) / span) * (height - pad.top - pad.bottom);
  const zeroY = yAt(0);
  const rowHeight = (height - pad.top - pad.bottom) / Math.max(values.length, 1);
  const barMax = width - pad.left - pad.right;

  return (
    <div className="article-chart-plot">
      {!hasData ? (
        <p className="article-chart-empty">数据不可用</p>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${visual.title}，纵轴单位 ${visual.unit}，数据截至 ${visual.dataThrough}`}
          className="article-chart-svg"
        >
          <line x1={pad.left} x2={width - pad.right} y1={zeroY} y2={zeroY} className="article-chart-axis" />
          {values.map((point, index) => {
            const y = yAt(point.y as number);
            const barLength = Math.max(Math.abs((point.y as number) / span) * barMax, 2);
            const direction = (point.y as number) >= 0 ? 1 : -1;
            const barX = direction > 0 ? pad.left : pad.left - barLength;
            return (
              <g key={`${point.x}-${index}`}>
                <rect x={barX} y={Math.min(y, zeroY) + rowHeight * 0.25} width={barLength} height={rowHeight * 0.5} className={`article-chart-bar ${direction >= 0 ? "article-chart-bar-0" : "article-chart-bar-1"}`}>
                  <title>{`${point.x}: ${point.y}${visual.unit === "percent" ? "%" : ""}`}</title>
                </rect>
                <text x={pad.left - 8} y={zeroY + rowHeight * 0.62} textAnchor="end" className="article-chart-tick">
                  {point.x}
                </text>
                <text x={direction > 0 ? barX + barLength + 4 : barX - 4} y={zeroY + rowHeight * 0.62} className="article-chart-value">
                  {point.y}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
