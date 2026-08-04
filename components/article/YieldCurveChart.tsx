import type { ArticleVisual } from "@/lib/types";

function numeric(points: ArticleVisual["points"], x: string, seriesId: string): number | null {
  const point = points.find((item) => item.x === x && item.seriesId === seriesId);
  return point ? point.y : null;
}

export default function YieldCurveChart({ visual }: { visual: ArticleVisual }) {
  const width = 640;
  const height = 300;
  const pad = { left: 46, right: 16, top: 18, bottom: 34 };
  const xValues = [...new Set(visual.points.map((point) => point.x))];
  const yValues = visual.points.map((point) => point.y).filter((value): value is number => value !== null);
  const hasData = yValues.length > 0;
  const yMin = hasData ? Math.min(...yValues) - 0.2 : 0;
  const yMax = hasData ? Math.max(...yValues) + 0.2 : 1;
  const xStep = xValues.length > 1 ? (width - pad.left - pad.right) / (xValues.length - 1) : 0;
  const xAt = (x: string) => (xValues.length === 1 ? pad.left : pad.left + xValues.indexOf(x) * xStep);
  const yAt = (value: number) => pad.top + (1 - (value - yMin) / (yMax - yMin)) * (height - pad.top - pad.bottom);
  const line = (seriesId: string) =>
    xValues
      .map((x, index) => {
        const y = numeric(visual.points, x, seriesId);
        if (y === null) return null;
        return `${index === 0 ? "M" : "L"}${xAt(x).toFixed(1)},${yAt(y).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");

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
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
            const value = yMin + (yMax - yMin) * tick;
            return (
              <g key={tick}>
                <line x1={pad.left} x2={width - pad.right} y1={yAt(value)} y2={yAt(value)} className="article-chart-grid" />
                <text x={pad.left - 6} y={yAt(value) + 4} textAnchor="end" className="article-chart-tick">
                  {value.toFixed(2)}
                </text>
              </g>
            );
          })}
          {visual.series.map((series, index) => (
            <path key={series.id} d={line(series.id)} fill="none" className={`article-chart-line article-chart-line-${index}`} />
          ))}
          {visual.points.map((point, index) =>
            point.y === null ? null : (
              <circle key={`${point.x}-${point.seriesId}-${index}`} cx={xAt(point.x)} cy={yAt(point.y)} r={3.5} className="article-chart-dot" />
            ),
          )}
          {xValues.map((x) => (
            <text key={x} x={xAt(x)} y={height - 10} textAnchor="middle" className="article-chart-tick">
              {x}
            </text>
          ))}
        </svg>
      )}
      <div className="article-chart-legend">
        {visual.series.map((series, index) => (
          <span key={series.id} className="article-chart-legend-item">
            <i className={`article-chart-swatch article-chart-swatch-${index}`} />
            {series.label}
          </span>
        ))}
      </div>
    </div>
  );
}
