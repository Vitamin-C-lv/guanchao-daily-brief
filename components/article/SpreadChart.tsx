import type { ArticleVisual } from "@/lib/types";

export default function SpreadChart({ visual }: { visual: ArticleVisual }) {
  const width = 640;
  const height = 300;
  const pad = { left: 46, right: 16, top: 18, bottom: 34 };
  const values = visual.points.filter((point) => point.y !== null);
  const hasData = values.length > 0;
  const yValues = values.map((point) => point.y as number);
  const yMin = hasData ? Math.min(0, ...yValues) : 0;
  const yMax = hasData ? Math.max(0, ...yValues) : 1;
  const span = yMax - yMin || 1;
  const yAt = (value: number) => pad.top + (1 - (value - yMin) / span) * (height - pad.top - pad.bottom);
  const zeroY = yAt(0);
  const categories = [...new Set(values.map((point) => point.x))];
  const seriesIds = [...new Set(values.map((point) => point.seriesId))];
  const slot = (width - pad.left - pad.right) / Math.max(categories.length * seriesIds.length, 1);
  const barWidth = Math.max(6, Math.min(28, slot * 0.7));

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
          {categories.map((category, categoryIndex) =>
            seriesIds.map((seriesId, seriesIndex) => {
              const point = values.find((item) => item.x === category && item.seriesId === seriesId);
              if (!point || point.y === null) return null;
              const center = pad.left + (categoryIndex * seriesIds.length + seriesIndex) * slot + slot / 2;
              const y = yAt(point.y);
              return (
                <g key={`${category}-${seriesId}`}>
                  <rect
                    x={center - barWidth / 2}
                    y={Math.min(y, zeroY)}
                    width={barWidth}
                    height={Math.max(Math.abs(zeroY - y), 1)}
                    className={`article-chart-bar article-chart-bar-${seriesIndex}`}
                  >
                    <title>{`${category} ${seriesId}: ${point.y}${visual.unit === "percent" ? "%" : visual.unit === "bp" ? "bp" : ""}`}</title>
                  </rect>
                </g>
              );
            }),
          )}
          {categories.map((category, categoryIndex) => (
            <text
              key={category}
              x={pad.left + (categoryIndex * seriesIds.length + (seriesIds.length - 1) / 2) * slot + slot / 2}
              y={height - 10}
              textAnchor="middle"
              className="article-chart-tick"
            >
              {category}
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
