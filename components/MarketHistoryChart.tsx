"use client";

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
} from "lightweight-charts";
import type { IChartApi, ISeriesApi, MouseEventParams, Time } from "lightweight-charts";
import { Maximize2, Minus, Plus, RefreshCw, Scan, Shrink, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MarketHistoryBar, MarketHistoryDocument } from "@/lib/market-history";
import { movingAverageConvergenceDivergence, simpleMovingAverage } from "@/lib/market-indicators";

type RangeKey = "1M" | "3M" | "6M" | "1Y" | "ALL";
type ChartMode = "candles" | "close";
type HoverSnapshot = { date: string; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null };

const MINIMUM_READY_ROWS = 252;
const MA_CONFIG = [
  { key: "ma5", label: "MA5", period: 5, color: "#5876a8" },
  { key: "ma10", label: "MA10", period: 10, color: "#bc7c3d" },
  { key: "ma20", label: "MA20", period: 20, color: "#5c9c86" },
  { key: "ma60", label: "MA60", period: 60, color: "#7d7680" },
] as const;

function validBars(history: MarketHistoryDocument) {
  return history.bars.filter((bar) => bar.open !== null && bar.high !== null && bar.low !== null && bar.close !== null);
}

function formatNumber(value: number | null, digits = 2) {
  return value === null || !Number.isFinite(value) ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function rangeCount(range: RangeKey, length: number) {
  if (range === "1M") return Math.min(21, length);
  if (range === "3M") return Math.min(63, length);
  if (range === "6M") return Math.min(126, length);
  if (range === "1Y") return Math.min(252, length);
  return length;
}

function applyRange(chart: IChartApi, range: RangeKey, length: number) {
  const count = rangeCount(range, length);
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, length - count - 1), to: Math.max(0, length - 1) });
}

function chartData(bar: MarketHistoryBar[]) {
  const candles = bar.filter((item) => item.open !== null && item.high !== null && item.low !== null && item.close !== null).map((item) => ({ time: item.time, open: item.open!, high: item.high!, low: item.low!, close: item.close! }));
  const close = bar.filter((item) => item.close !== null).map((item) => ({ time: item.time, value: item.close! }));
  const volume = bar.filter((item) => item.volume !== null && item.close !== null).map((item, index, all) => ({ time: item.time, value: item.volume!, color: index === 0 || (all[index - 1].close !== null && item.close! >= all[index - 1].close!) ? "#df4d4d99" : "#219b6399" }));
  return { candles, close, volume };
}

export default function MarketHistoryChart({ history }: { history: MarketHistoryDocument }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const closeSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const maSeriesRef = useRef<Record<string, ISeriesApi<"Line">>>({});
  const macdSeriesRef = useRef<{ line: ISeriesApi<"Line">; signal: ISeriesApi<"Line">; histogram: ISeriesApi<"Histogram"> } | null>(null);
  const [range, setRange] = useState<RangeKey>("1Y");
  const [mode, setMode] = useState<ChartMode>("candles");
  const [maVisible, setMaVisible] = useState<Record<string, boolean>>({ ma5: true, ma10: true, ma20: true, ma60: true });
  const [macdVisible, setMacdVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hover, setHover] = useState<HoverSnapshot | null>(null);
  const bars = useMemo(() => validBars(history), [history]);
  const data = useMemo(() => chartData(bars), [bars]);

  useEffect(() => {
    if (!containerRef.current || !bars.length) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 520,
      layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#746d78" },
      grid: { vertLines: { color: "#f0edf2" }, horzLines: { color: "#f0edf2" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#9a8ca4", width: 1, style: 2, labelBackgroundColor: "#4a3f50" }, horzLine: { color: "#9a8ca4", width: 1, style: 2, labelBackgroundColor: "#4a3f50" } },
      rightPriceScale: { borderColor: "#e9e4eb", scaleMargins: { top: 0.08, bottom: 0.16 } },
      timeScale: { borderColor: "#e9e4eb", timeVisible: false, rightOffset: 6, barSpacing: 7, minBarSpacing: 2 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    const candle = chart.addSeries(CandlestickSeries, { upColor: "#df4d4d", downColor: "#219b63", borderUpColor: "#df4d4d", borderDownColor: "#219b63", wickUpColor: "#df4d4d", wickDownColor: "#219b63" });
    candle.setData(data.candles);
    const close = chart.addSeries(LineSeries, { color: "#4a4350", lineWidth: 2, visible: false });
    close.setData(data.close);
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", base: 0 });
    volume.setData(data.volume);
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const maSeries: Record<string, ISeriesApi<"Line">> = {};
    MA_CONFIG.forEach((item) => {
      const series = chart.addSeries(LineSeries, { color: item.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      series.setData(simpleMovingAverage(bars as MarketHistoryBar[], item.period));
      maSeries[item.key] = series;
    });

    const closeValues = data.close;
    const macdData = movingAverageConvergenceDivergence(closeValues.map((item) => ({ time: String(item.time), value: item.value })), 12, 26, 9);
    const macd = macdData.line.map((item) => ({ time: item.time as Time, value: item.value }));
    const signal = macdData.signal.map((item) => ({ time: item.time as Time, value: item.value }));
    const histogram = macdData.histogram.map((item) => ({ time: item.time as Time, value: item.value, color: item.value >= 0 ? "#df4d4d99" : "#219b6399" }));
    const macdLine = chart.addSeries(LineSeries, { color: "#5876a8", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 2);
    macdLine.setData(macd);
    const signalLine = chart.addSeries(LineSeries, { color: "#bc7c3d", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 2);
    signalLine.setData(signal);
    const macdHistogram = chart.addSeries(HistogramSeries, { priceFormat: { type: "price", precision: 3, minMove: 0.001 }, priceScaleId: "macd", base: 0 }, 2);
    macdHistogram.setData(histogram);
    chart.priceScale("macd", 2).applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });

    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      const item = param.seriesData.get(candle) as { open?: number; high?: number; low?: number; close?: number; time?: Time } | undefined;
      const volumeItem = param.seriesData.get(volume) as { value?: number } | undefined;
      if (!item || item.open === undefined || item.high === undefined || item.low === undefined || item.close === undefined) {
        setHover(null);
        return;
      }
      setHover({ date: String(item.time ?? param.time ?? ""), open: item.open, high: item.high, low: item.low, close: item.close, volume: volumeItem?.value ?? null });
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);
    chartRef.current = chart;
    candleSeriesRef.current = candle;
    closeSeriesRef.current = close;
    volumeSeriesRef.current = volume;
    maSeriesRef.current = maSeries;
    macdSeriesRef.current = { line: macdLine, signal: signalLine, histogram: macdHistogram };
    applyRange(chart, range, bars.length);

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth, height: Math.max(520, containerRef.current.clientHeight) });
    });
    resizeObserver.observe(containerRef.current);
    const fullscreenListener = () => setIsFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", fullscreenListener);
    return () => {
      resizeObserver.disconnect();
      document.removeEventListener("fullscreenchange", fullscreenListener);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      closeSeriesRef.current = null;
      volumeSeriesRef.current = null;
      maSeriesRef.current = {};
      macdSeriesRef.current = null;
    };
    // The chart is intentionally recreated only when the normalized history changes.
    // Toolbar state is applied by the effects below so the canvas remains stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, data]);

  useEffect(() => {
    if (!chartRef.current) return;
    applyRange(chartRef.current, range, bars.length);
  }, [bars.length, range]);

  useEffect(() => {
    candleSeriesRef.current?.applyOptions({ visible: mode === "candles" });
    closeSeriesRef.current?.applyOptions({ visible: mode === "close" });
  }, [mode]);

  useEffect(() => {
    MA_CONFIG.forEach((item) => maSeriesRef.current[item.key]?.applyOptions({ visible: maVisible[item.key] }));
  }, [maVisible]);

  useEffect(() => {
    const macd = macdSeriesRef.current;
    if (!macd) return;
    macd.line.applyOptions({ visible: macdVisible });
    macd.signal.applyOptions({ visible: macdVisible });
    macd.histogram.applyOptions({ visible: macdVisible });
    const pane = chartRef.current?.panes()[2];
    if (pane) pane.setHeight(macdVisible ? 145 : 1);
  }, [macdVisible]);

  const zoom = (factor: number) => {
    const chart = chartRef.current;
    const visible = chart?.timeScale().getVisibleLogicalRange();
    if (!chart || !visible) return;
    const center = (visible.from + visible.to) / 2;
    const span = Math.max(20, (visible.to - visible.from) * factor);
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(-1, center - span / 2), to: Math.min(bars.length - 1, center + span / 2) });
  };

  const reset = () => {
    setRange("1Y");
    if (chartRef.current) applyRange(chartRef.current, "1Y", bars.length);
  };

  const fit = () => chartRef.current?.timeScale().fitContent();

  const toggleFullscreen = async () => {
    if (!shellRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await shellRef.current.requestFullscreen();
  };

  const latest = hover ?? (() => {
    const last = bars.at(-1);
    return last ? { date: last.time, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume } : null;
  })();

  return (
    <section ref={shellRef} className={`market-history-chart-shell ${isFullscreen ? "is-fullscreen" : ""}`} aria-label="历史行情图表">
      <div className="market-history-chart-head">
        <div>
          <span className="eyebrow">OHLC / TECHNICALS</span>
          <h2>{mode === "candles" ? "日 K 线" : "收盘线"}</h2>
        </div>
        <div className="market-history-crosshair" aria-live="polite">
          <span>{latest?.date ?? "移动十字光标查看"}</span>
          <b>O {formatNumber(latest?.open ?? null)}</b><b>H {formatNumber(latest?.high ?? null)}</b><b>L {formatNumber(latest?.low ?? null)}</b><b>C {formatNumber(latest?.close ?? null)}</b><b>量 {latest?.volume == null ? "—" : latest.volume.toLocaleString("zh-CN")}</b>
        </div>
      </div>
      <div className="market-history-toolbar" role="toolbar" aria-label="行情图表控制">
        <div className="market-history-control-group" aria-label="时间范围">
          {(["1M", "3M", "6M", "1Y", "ALL"] as RangeKey[]).map((item) => <button key={item} type="button" className={range === item ? "active" : ""} onClick={() => setRange(item)}>{item === "ALL" ? "全部" : item}</button>)}
        </div>
        <div className="market-history-control-group" aria-label="图表类型">
          <button type="button" className={mode === "candles" ? "active" : ""} onClick={() => setMode("candles")}>K线</button>
          <button type="button" className={mode === "close" ? "active" : ""} onClick={() => setMode("close")}>收盘线</button>
        </div>
        <div className="market-history-control-group market-history-ma-group" aria-label="均线">
          {MA_CONFIG.map((item) => <button key={item.key} type="button" className={maVisible[item.key] ? "active" : ""} onClick={() => setMaVisible((current) => ({ ...current, [item.key]: !current[item.key] }))}>{item.label}</button>)}
          <button type="button" className={macdVisible ? "active" : ""} onClick={() => setMacdVisible((value) => !value)}>MACD</button>
        </div>
        <div className="market-history-control-group market-history-icon-controls" aria-label="缩放和视图">
          <button type="button" onClick={() => zoom(0.72)} aria-label="放大"><ZoomIn size={15} /></button>
          <button type="button" onClick={() => zoom(1.4)} aria-label="缩小"><ZoomOut size={15} /></button>
          <button type="button" onClick={reset} aria-label="复位"><RefreshCw size={15} /></button>
          <button type="button" onClick={fit} aria-label="适应全部"><Scan size={15} /></button>
          <button type="button" onClick={() => void toggleFullscreen()} aria-label={isFullscreen ? "退出全屏" : "全屏"}>{isFullscreen ? <Shrink size={15} /> : <Maximize2 size={15} />}</button>
        </div>
      </div>
      <div className="market-history-chart-legend" aria-label="图例">
        <span><i className="legend-candle-up" />上涨</span><span><i className="legend-candle-down" />下跌</span><span><i className="legend-volume" />成交量</span>{MA_CONFIG.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}<span><i className="legend-macd" />MACD 12,26,9</span>
      </div>
      <div ref={containerRef} className="market-history-chart-canvas" />
      <p className="market-history-chart-hint"><Plus size={13} />滚轮缩放 · 按住拖动 · 十字光标显示 OHLC 与成交量</p>
    </section>
  );
}

export { MINIMUM_READY_ROWS };
