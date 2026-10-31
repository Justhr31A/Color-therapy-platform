/**
 * Alignment metrics, shared by the synthetic benchmark, the tests and the real-recording report. Pure.
 * Errors are in palm widths (see arAcceptance.js).
 */
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** { n, median, p95, max, mean, withinRate } for a list of errors; `within` is the tolerance for withinRate. */
export function summarizeErrors(errors, within = 0.1) {
  const e = errors.filter(Number.isFinite).sort((a, b) => a - b);
  const n = e.length;
  return {
    n,
    median: quantile(e, 0.5),
    p95: quantile(e, 0.95),
    max: n ? e[n - 1] : NaN,
    mean: n ? e.reduce((s, x) => s + x, 0) / n : NaN,
    within,
    withinRate: n ? e.filter((x) => x <= within).length / n : NaN,
  };
}

/** Pass/fail of a summary against a threshold block { median, p95, within, withinRate }. */
export function checkThresholds(summary, t) {
  const fails = [];
  if (t.median != null && !(summary.median <= t.median)) fails.push(`median ${summary.median.toFixed(4)} > ${t.median}`);
  if (t.p95 != null && !(summary.p95 <= t.p95)) fails.push(`p95 ${summary.p95.toFixed(4)} > ${t.p95}`);
  if (t.withinRate != null) {
    if (!(summary.withinRate >= t.withinRate)) fails.push(`within ${t.within}: ${(summary.withinRate * 100).toFixed(1)} % < ${t.withinRate * 100} %`);
  }
  return { pass: fails.length === 0, fails };
}

/** RMS distance of a track of points from its own mean (stationary jitter), in the same unit as the points. */
export function jitterRms(points) {
  if (!points.length) return NaN;
  const m = points.reduce((a, p) => ({ x: a.x + p.x / points.length, y: a.y + p.y / points.length }), { x: 0, y: 0 });
  return Math.sqrt(points.reduce((s, p) => s + (p.x - m.x) ** 2 + (p.y - m.y) ** 2, 0) / points.length);
}

/** Palm width (index MCP → little MCP) of a 21-point hand. */
export const palmWidthOf = (lm) => Math.hypot(lm[17].x - lm[5].x, lm[17].y - lm[5].y);
