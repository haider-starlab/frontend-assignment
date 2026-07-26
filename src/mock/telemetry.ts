/**
 * Telemetry is generated on demand, never stored.
 *
 * 900 zones x 7 days at 1-minute resolution would be ~9 million points and
 * several hundred MB as fixtures, so instead this is a pure function of
 * (zoneId, timestamp) with a per-zone seed. Same zone, same minute, same
 * numbers — for you and for the reviewer.
 *
 * The simulation is deliberately simple but physically plausible:
 *   - each zone has 1-2 irrigation windows per day, seeded from its id
 *   - flow rises to nominal when the valve is open, zero when closed
 *   - line pressure SAGS while irrigating (the interesting bit — a naive
 *     mock gets this backwards)
 *   - soil moisture climbs during irrigation and decays exponentially after,
 *     with a diurnal evapotranspiration wobble
 */

import { createRng, smoothNoise } from './rng';
import type { TelemetryPoint, TelemetryRange } from './types';

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;

export const RANGE_MINUTES: Record<TelemetryRange, number> = {
  '1h': 60,
  '6h': 360,
  '24h': DAY_MINUTES,
  '7d': DAY_MINUTES * 7,
};

interface ZoneProfile {
  nominalFlowGpm: number;
  staticPressurePsi: number;
  fieldCapacityPct: number;
  wiltingPointPct: number;
  /** Minutes past local midnight at which each window opens. */
  windows: Array<{ startMinute: number; durationMinutes: number }>;
  /** Fraction of moisture lost per minute when not irrigating. */
  dryingRate: number;
}

const profileCache = new Map<string, ZoneProfile>();

/** Derive a zone's hydraulic personality from its id. Stable forever. */
export function getZoneProfile(zoneId: string): ZoneProfile {
  const cached = profileCache.get(zoneId);
  if (cached) return cached;

  const rng = createRng(`profile:${zoneId}`);
  const windows: ZoneProfile['windows'] = [];

  // Window starts are spread uniformly across the whole 24 hours rather
  // than clustered into a morning band. Two reasons: large operations
  // stagger blocks to stay inside pump and canal capacity, and sites here
  // span four timezones. It also means the fleet is never all-idle, so the
  // "currently irrigating" strip always has something in it.
  windows.push({
    startMinute: rng.int(0, DAY_MINUTES - 1),
    durationMinutes: rng.int(60, 180),
  });
  if (rng.chance(0.35)) {
    windows.push({
      // Second set, well separated from the first (may wrap past midnight).
      startMinute: (windows[0]!.startMinute + rng.int(400, 900)) % DAY_MINUTES,
      durationMinutes: rng.int(45, 120),
    });
  }

  const wiltingPointPct = rng.float(11, 17);
  const profile: ZoneProfile = {
    nominalFlowGpm: rng.int(45, 620),
    staticPressurePsi: rng.float(64, 82),
    fieldCapacityPct: rng.float(30, 41),
    wiltingPointPct,
    windows,
    dryingRate: rng.float(0.00004, 0.00013),
  };

  profileCache.set(zoneId, profile);
  return profile;
}

/** Minutes elapsed since UTC midnight for a given instant. */
function minuteOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

interface ActiveWindow {
  durationMinutes: number;
  /** Fraction [0,1) of the way through the window. */
  progress: number;
}

/**
 * The irrigation window covering `ms`, if any. Handles windows that wrap
 * past midnight, which a naive `m >= start && m < start + duration` check
 * silently drops.
 */
function activeWindow(zoneId: string, ms: number): ActiveWindow | null {
  const { windows } = getZoneProfile(zoneId);
  const m = minuteOfDay(ms);

  for (const { startMinute, durationMinutes } of windows) {
    const elapsed = (m - startMinute + DAY_MINUTES) % DAY_MINUTES;
    if (elapsed < durationMinutes) {
      return { durationMinutes, progress: elapsed / durationMinutes };
    }
  }
  return null;
}

/**
 * Whether the synthetic schedule has this zone's valve open at `ms`.
 * Exported because seed.ts uses it too, so the zones grid and the chart
 * tell the same story.
 */
export function isIrrigatingAt(zoneId: string, ms: number): boolean {
  return activeWindow(zoneId, ms) !== null;
}

/**
 * Generate a telemetry series ending at `endMs` (quantised to the minute).
 *
 * Soil moisture is stateful, so the series is simulated forward from a
 * warm-up period before the requested window. That keeps the curve
 * continuous rather than jumping at the left edge of the chart.
 */
export function generateTelemetry(
  zoneId: string,
  range: TelemetryRange,
  endMs: number = Date.now(),
): TelemetryPoint[] {
  const profile = getZoneProfile(zoneId);
  const points = RANGE_MINUTES[range];
  const end = Math.floor(endMs / MINUTE_MS) * MINUTE_MS;
  const start = end - (points - 1) * MINUTE_MS;

  // Warm up long enough for moisture to forget its arbitrary starting value.
  const warmUpMinutes = 720;
  let moisture = (profile.fieldCapacityPct + profile.wiltingPointPct) / 2;

  for (let i = warmUpMinutes; i > 0; i -= 1) {
    moisture = stepMoisture(zoneId, profile, moisture, start - i * MINUTE_MS);
  }

  const series: TelemetryPoint[] = new Array(points);

  for (let i = 0; i < points; i += 1) {
    const t = start + i * MINUTE_MS;
    const window = activeWindow(zoneId, t);
    const open = window !== null;

    // Ramp flow in over the first ~4 minutes and out over the last ~4,
    // so the chart has believable edges rather than square waves.
    let ramp = 1;
    if (window) {
      const edge = Math.min(4 / window.durationMinutes, 0.2);
      const { progress } = window;
      if (progress < edge) ramp = progress / edge;
      else if (progress > 1 - edge) ramp = (1 - progress) / edge;
      ramp = Math.max(0.05, Math.min(1, ramp));
    }

    const flowNoise = smoothNoise(`flow:${zoneId}`, t / (12 * MINUTE_MS)) * 0.035;
    const flowGpm = open ? Math.max(0, profile.nominalFlowGpm * ramp * (1 + flowNoise)) : 0;

    // Pressure drops roughly with the square of flow, plus slow drift.
    const load = profile.nominalFlowGpm > 0 ? flowGpm / profile.nominalFlowGpm : 0;
    const sag = 26 * load * load;
    const pressureNoise = smoothNoise(`psi:${zoneId}`, t / (25 * MINUTE_MS)) * 1.8;
    const pressurePsi = Math.max(0, profile.staticPressurePsi - sag + pressureNoise);

    moisture = stepMoisture(zoneId, profile, moisture, t);

    series[i] = {
      t: new Date(t).toISOString(),
      flowGpm: Number(flowGpm.toFixed(1)),
      pressurePsi: Number(pressurePsi.toFixed(1)),
      soilMoisturePct: Number(moisture.toFixed(2)),
    };
  }

  return series;
}

function stepMoisture(
  zoneId: string,
  profile: ZoneProfile,
  current: number,
  t: number,
): number {
  const open = isIrrigatingAt(zoneId, t);
  const { fieldCapacityPct, wiltingPointPct, dryingRate } = profile;

  if (open) {
    // Asymptotic approach to field capacity — wetting is fast at first.
    const headroom = fieldCapacityPct + 2 - current;
    return current + headroom * 0.012;
  }

  // Exponential decay toward wilting point, modulated by time of day so
  // the crop transpires more in the afternoon.
  const hour = minuteOfDay(t) / 60;
  const etFactor = 0.55 + 0.75 * Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI));
  const deficit = current - wiltingPointPct;
  const drift = smoothNoise(`vwc:${zoneId}`, t / (180 * MINUTE_MS)) * 0.004;
  return Math.max(wiltingPointPct * 0.9, current - deficit * dryingRate * 60 * etFactor + drift);
}
