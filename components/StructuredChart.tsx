import type { CSSProperties } from "react";
import type { SourceLink, StructuredChart as StructuredChartData, StructuredChartSeries, Tone } from "@/lib/types";

const toneColor: Record<Tone, string> = {
  positive: "#c95151",
  negative: "#338b61",
  neutral: "#75657f",
  warning: "#b47b24",
};

function ChartSourceRefs({ indexes, sources }: { indexes: number[]; sources: SourceLink[] }) {
  return (
    <span className="structured-chart-refs" aria-label="图表引用">
      {[...new Set(indexes)].map((index) => {
        const source = sources[index];
        if (!source) return null;
        return (
          <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer" title={source.name}>
            [{index + 1}]
          </a>
        );
      })}
    </span>
  );
}

function FigureHeading({ chart, sources }: { chart: StructuredChartData; sources: SourceLink[] }) {
  return (
    <figcaption className="structured-chart-heading">
      <div>
        <strong>{chart.title}</strong>
        <span>{chart.unit}</span>
      </div>
      <p>
        截至 {chart.asOf}
        <ChartSourceRefs indexes={chart.sourceIndexes} sources={sources} />
      </p>
    </figcaption>
  );
}

function ToneBar({ tone, width, left }: { tone: Tone; width: number; left?: number }) {
  const style = {
    width: `${Math.max(0, Math.min(100, width))}%`,
    minWidth: width > 0 ? "2px" : "0",
    ...(left === undefined ? {} : { left: `${Math.max(0, Math.min(100, left))}%` }),
  } as CSSProperties;

  return <i className={`tone-${tone}`} style={style} />;
}

function BarChart({ chart }: { chart: Extract<StructuredChartData, { type: "bar" | "diverging-bar" }> }) {
  const isDiverging = chart.type === "diverging-bar";
  const maxValue = Math.max(...chart.items.map((item) => Math.abs(item.value)), 1);

  return (
    <div className={`structured-bars ${isDiverging ? "is-diverging" : ""}`}>
      {chart.items.map((item) => {
        const relative = Math.abs(item.value) / maxValue;
        const width = relative * (isDiverging ? 50 : 100);
        const left = isDiverging ? (item.value < 0 ? 50 - width : 50) : undefined;
        return (
          <div className="structured-bar-row" key={`${item.label}-${item.display}`}>
            <span>{item.label}</span>
            <div className="structured-bar-track" aria-hidden="true">
              {isDiverging ? <b className="structured-zero-axis" /> : null}
              <ToneBar tone={item.tone} width={width} left={left} />
            </div>
            <strong>{item.display}</strong>
          </div>
        );
      })}
    </div>
  );
}

function compactNumber(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (absolute >= 100) return value.toFixed(0);
  if (absolute >= 10) return value.toFixed(1);
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function buildLinePath(
  series: StructuredChartSeries,
  x: (index: number) => number,
  y: (value: number) => number,
) {
  return series.items.map((item, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(item.value)}`).join(" ");
}

function AccessibleSeriesTable({ chart }: { chart: Extract<StructuredChartData, { type: "line" | "grouped-bar" }> }) {
  const labels = chart.series[0]?.items.map((item) => item.label) ?? [];
  return (
    <table className="chart-sr-only">
      <caption>{chart.title}</caption>
      <thead><tr><th>项目</th>{chart.series.map((series) => <th key={series.name}>{series.name}</th>)}</tr></thead>
      <tbody>
        {labels.map((label, index) => (
          <tr key={label}>
            <th>{label}</th>
            {chart.series.map((series) => <td key={series.name}>{series.items[index]?.display ?? "—"}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LineChart({ chart }: { chart: Extract<StructuredChartData, { type: "line" }> }) {
  const firstSeries = chart.series[0];
  if (!firstSeries?.items.length) return null;

  const width = 640;
  const height = 246;
  const padding = { top: 22, right: 22, bottom: 45, left: 50 };
  const values = chart.series.flatMap((series) => series.items.map((item) => item.value));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = rawMax - rawMin || Math.max(Math.abs(rawMax), 1);
  const minY = rawMin - span * 0.1;
  const maxY = rawMax + span * 0.1;
  const pointCount = firstSeries.items.length;
  const x = (index: number) => padding.left + (index / Math.max(pointCount - 1, 1)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + ((maxY - value) / (maxY - minY)) * (height - padding.top - padding.bottom);
  const ticks = Array.from({ length: 4 }, (_, index) => maxY - (index / 3) * (maxY - minY));
  const labelStep = Math.max(1, Math.ceil(pointCount / 6));

  return (
    <div className="structured-line-wrap">
      <div className="structured-chart-legend" aria-label="图例">
        {chart.series.map((series) => (
          <span key={series.name}>
            <i style={{ background: toneColor[series.tone] }} />
            {series.name}{series.kind === "institution-forecast" ? "（机构预测）" : ""}
          </span>
        ))}
      </div>
      <svg className="structured-line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={chart.title}>
        <title>{chart.title}</title>
        <desc>{chart.series.map((series) => `${series.name}：${series.items.map((item) => `${item.label} ${item.display}`).join("，")}`).join("；")}</desc>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} className="structured-grid-line" />
            <text x={padding.left - 9} y={y(tick) + 4} textAnchor="end" className="structured-axis-label">{compactNumber(tick)}</text>
          </g>
        ))}
        {firstSeries.items.map((item, index) => {
          const showLabel = index === 0 || index === pointCount - 1 || index % labelStep === 0;
          return showLabel ? <text key={item.label} x={x(index)} y={height - 16} textAnchor="middle" className="structured-axis-label">{item.label}</text> : null;
        })}
        {chart.series.map((series) => (
          <g key={series.name}>
            <path
              d={buildLinePath(series, x, y)}
              fill="none"
              stroke={toneColor[series.tone]}
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={series.kind === "institution-forecast" ? "7 6" : undefined}
            />
            {series.items.map((item, index) => (
              <circle key={`${item.label}-${index}`} cx={x(index)} cy={y(item.value)} r="3.2" fill="#fff" stroke={toneColor[series.tone]} strokeWidth="2" />
            ))}
          </g>
        ))}
      </svg>
      <AccessibleSeriesTable chart={chart} />
    </div>
  );
}

function GroupedBarChart({ chart }: { chart: Extract<StructuredChartData, { type: "grouped-bar" }> }) {
  const labels = chart.series[0]?.items.map((item) => item.label) ?? [];
  const maxValue = Math.max(...chart.series.flatMap((series) => series.items.map((item) => Math.abs(item.value))), 1);

  return (
    <div className="structured-grouped-wrap">
      <div className="structured-chart-legend" aria-label="图例">
        {chart.series.map((series) => (
          <span key={series.name}><i style={{ background: toneColor[series.tone] }} />{series.name}{series.kind === "institution-forecast" ? "（机构预测）" : ""}</span>
        ))}
      </div>
      <div className="structured-grouped-bars">
        {labels.map((label, labelIndex) => (
          <section key={label}>
            <h4>{label}</h4>
            {chart.series.map((series) => {
              const item = series.items[labelIndex];
              if (!item) return null;
              return (
                <div key={series.name} className="structured-group-row">
                  <span>{series.name}</span>
                  <div aria-hidden="true"><ToneBar tone={series.tone} width={Math.abs(item.value) / maxValue * 100} /></div>
                  <strong>{item.display}</strong>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <AccessibleSeriesTable chart={chart} />
    </div>
  );
}

export default function StructuredChart({ chart, sources }: { chart: StructuredChartData; sources: SourceLink[] }) {
  return (
    <figure className={`structured-chart-card structured-chart-${chart.type}`}>
      <FigureHeading chart={chart} sources={sources} />
      {chart.type === "bar" || chart.type === "diverging-bar" ? <BarChart chart={chart} /> : null}
      {chart.type === "line" ? <LineChart chart={chart} /> : null}
      {chart.type === "grouped-bar" ? <GroupedBarChart chart={chart} /> : null}
      {chart.note ? <p className="structured-chart-note">口径：{chart.note}</p> : null}
    </figure>
  );
}
