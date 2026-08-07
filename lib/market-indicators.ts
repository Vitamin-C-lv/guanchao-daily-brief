export type IndicatorPoint = { time: string; value: number };
export type CloseBar = { time: string; close: number | null };

export function simpleMovingAverage(bars: CloseBar[], period: number): IndicatorPoint[] {
  if (!Number.isInteger(period) || period < 1) return [];
  const output: IndicatorPoint[] = [];
  for (let index = period - 1; index < bars.length; index += 1) {
    const window = bars.slice(index - period + 1, index + 1).map((bar) => bar.close);
    if (window.some((value) => value === null)) continue;
    const numbers = window.filter((value): value is number => value !== null);
    output.push({ time: bars[index].time, value: numbers.reduce((sum, value) => sum + value, 0) / period });
  }
  return output;
}

export function exponentialMovingAverage(values: IndicatorPoint[], period: number): IndicatorPoint[] {
  if (!Number.isInteger(period) || period < 1) return [];
  const output: IndicatorPoint[] = [];
  const multiplier = 2 / (period + 1);
  let previous: number | null = null;
  values.forEach((item, index) => {
    if (previous === null) {
      if (index < period - 1) return;
      previous = values.slice(index - period + 1, index + 1).reduce((sum, current) => sum + current.value, 0) / period;
    } else {
      previous = (item.value - previous) * multiplier + previous;
    }
    output.push({ time: item.time, value: previous });
  });
  return output;
}

export function movingAverageConvergenceDivergence(values: IndicatorPoint[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fast = exponentialMovingAverage(values, fastPeriod);
  const slow = exponentialMovingAverage(values, slowPeriod);
  const slowMap = new Map(slow.map((item) => [item.time, item.value]));
  const line = fast.flatMap((item) => {
    const slowValue = slowMap.get(item.time);
    return slowValue === undefined ? [] : [{ time: item.time, value: item.value - slowValue }];
  });
  const signal = exponentialMovingAverage(line, signalPeriod);
  const signalMap = new Map(signal.map((item) => [item.time, item.value]));
  const histogram = line.flatMap((item) => {
    const signalValue = signalMap.get(item.time);
    return signalValue === undefined ? [] : [{ time: item.time, value: item.value - signalValue }];
  });
  return { line, signal, histogram };
}
