export interface ChartPoint {
  x: number;
  y: number;
}

export function buildPoints(
  values: readonly number[],
  width: number,
  height: number,
  padding: number,
  minValue?: number,
  maxValue?: number,
): ChartPoint[] {
  const min = minValue ?? Math.min(...values);
  const max = maxValue ?? Math.max(...values);
  const range = max - min || 1;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;

  return values.map((value, index) => {
    const x = padding + (index * innerWidth) / Math.max(values.length - 1, 1);
    const y = padding + innerHeight - ((value - min) / range) * innerHeight;

    return { x, y };
  });
}

export function buildLinePath(points: ChartPoint[]) {
  return points
    .map((point, index) =>
      `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
    )
    .join(" ");
}

export function buildAreaPath(points: ChartPoint[], height: number, padding: number) {
  if (points.length === 0) return "";

  const first = points[0];
  const last = points[points.length - 1];

  return `${buildLinePath(points)} L ${last.x.toFixed(2)} ${(height - padding).toFixed(
    2,
  )} L ${first.x.toFixed(2)} ${(height - padding).toFixed(2)} Z`;
}
