/**
 * Simulated real-time event stream.
 *
 * Implemented with timers rather than a real WebSocket so the whole thing
 * runs from `npm run dev` with no second process. The subscription shape
 * (`subscribe(handler) => unsubscribe`) is deliberately the same as a
 * socket wrapper, so swapping in a real transport later would not change
 * your consuming code.
 *
 * Behaviour you need to know about:
 *   - emits every 2-4 seconds while connected
 *   - drops roughly every 60 seconds, staying down 5-10 seconds
 *   - emits DISCONNECTED / CONNECTED around each outage
 *   - mutates the same store the REST handlers read from, so a refetch
 *     after an event returns consistent data
 */

import { db } from './db';
import { createRng } from './rng';
import { getZoneProfile, isIrrigatingAt } from './telemetry';
import type { Alarm, AlarmType, DeviceStatus, Severity, StreamEvent, ValveState } from './types';

export interface StreamOptions {
  /** Bounds for the gap between events, ms. */
  tickMs?: readonly [number, number];
  /** Mean time between simulated outages, ms. Set to 0 to disable. */
  outageEveryMs?: number;
  /** Bounds for outage duration, ms. */
  outageDurationMs?: readonly [number, number];
}

const DEFAULTS = {
  tickMs: [2000, 4000] as const,
  outageEveryMs: 60_000,
  outageDurationMs: [5000, 10_000] as const,
};

type Handler = (event: StreamEvent) => void;

const between = ([min, max]: readonly [number, number]): number => min + Math.random() * (max - min);

const ANOMALY_CATALOG: ReadonlyArray<{ type: AlarmType; severity: Severity; message: string }> = [
  { type: 'LOW_PRESSURE', severity: 'CRITICAL', message: 'Pressure dropped below 32 PSI setpoint' },
  { type: 'FLOW_ANOMALY', severity: 'WARNING', message: 'Flow 31% below expected — check filter' },
  { type: 'LEAK_SUSPECTED', severity: 'CRITICAL', message: 'Flow detected with valve commanded closed' },
  { type: 'BATTERY_LOW', severity: 'WARNING', message: 'Battery below 11.6 V — solar charge low' },
  { type: 'COMM_LOSS', severity: 'CRITICAL', message: 'No response for 3 polling cycles' },
  { type: 'HIGH_PRESSURE', severity: 'WARNING', message: 'Pressure exceeded 95 PSI' },
];

class EventStream {
  private handlers = new Set<Handler>();
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private outageTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = true;
  private options: Required<StreamOptions>;
  private tickCount = 0;

  constructor(options: StreamOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Subscribe to events. Returns an unsubscribe function. */
  subscribe(handler: Handler): () => void {
    this.handlers.add(handler);
    if (this.handlers.size === 1) this.start();

    // Tell the new subscriber where things stand right now.
    handler(this.connected ? { type: 'CONNECTED' } : { type: 'DISCONNECTED', reason: 'Radio link down' });

    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) this.stop();
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Force an outage now — handy while building your reconnect UI. */
  simulateOutage(durationMs = 7000): void {
    this.goDown(durationMs);
  }

  private start(): void {
    this.connected = true;
    this.scheduleTick();
    this.scheduleOutage();
  }

  private stop(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.outageTimer) clearTimeout(this.outageTimer);
    this.tickTimer = null;
    this.outageTimer = null;
  }

  private emit(event: StreamEvent): void {
    this.handlers.forEach((handler) => {
      try {
        handler(event);
      } catch (error) {
        // A throwing subscriber must not take the stream down with it.
        console.error('[mock stream] subscriber threw', error);
      }
    });
  }

  private scheduleTick(): void {
    this.tickTimer = setTimeout(() => {
      if (this.connected) this.tick();
      this.scheduleTick();
    }, between(this.options.tickMs));
  }

  private scheduleOutage(): void {
    if (this.options.outageEveryMs <= 0) return;
    // Jitter so outages don't land on a predictable beat.
    const wait = this.options.outageEveryMs * (0.75 + Math.random() * 0.5);
    this.outageTimer = setTimeout(() => {
      this.goDown(between(this.options.outageDurationMs));
    }, wait);
  }

  private goDown(durationMs: number): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit({ type: 'DISCONNECTED', reason: 'Radio link down — retrying' });

    setTimeout(() => {
      this.connected = true;
      this.emit({ type: 'CONNECTED' });
      this.scheduleOutage();
    }, durationMs);
  }

  /**
   * One tick emits a small batch: mostly telemetry, occasionally a state
   * change or a new alarm. Weighted so the UI feels alive without the
   * alarm feed turning into a firehose.
   */
  private tick(): void {
    this.tickCount += 1;
    const rng = createRng(`tick:${this.tickCount}:${Math.random()}`);

    // 3-6 telemetry updates, biased toward zones that are actually running.
    const irrigating = db.zones.filter((z) => z.valveState === 'IRRIGATING');
    const pool = irrigating.length > 0 ? irrigating : db.zones;
    const updates = rng.int(3, 6);

    for (let i = 0; i < updates; i += 1) {
      const zone = rng.chance(0.75) && pool.length > 0 ? rng.pick(pool) : rng.pick(db.zones);
      const controller = db.controllerForZone(zone.id);
      if (!controller || controller.status === 'OFFLINE') continue;

      const profile = getZoneProfile(zone.id);
      const open = zone.valveState === 'IRRIGATING';

      const flowGpm = open
        ? Number((profile.nominalFlowGpm * rng.float(0.88, 1.04)).toFixed(1))
        : 0;
      const pressurePsi = Number(
        (open ? rng.float(42, 60) : profile.staticPressurePsi + rng.float(-2, 2)).toFixed(1),
      );
      const soilMoisturePct = Number(
        Math.max(
          8,
          Math.min(45, zone.soilMoisturePct + (open ? rng.float(0.05, 0.3) : rng.float(-0.12, 0.02))),
        ).toFixed(2),
      );

      db.updateTelemetry(zone.id, { flowGpm, pressurePsi, soilMoisturePct });
      this.emit({
        type: 'TELEMETRY',
        zoneId: zone.id,
        flowGpm,
        pressurePsi,
        soilMoisturePct,
        t: new Date().toISOString(),
      });
    }

    // ~18% of ticks: a zone changes state on its own (a scheduled program
    // started or finished). Your UI must not assume it caused every change.
    if (rng.chance(0.18)) {
      const zone = rng.pick(db.zones);
      const controller = db.controllerForZone(zone.id);
      if (controller && controller.status !== 'OFFLINE' && zone.valveState !== 'FAULT') {
        const scheduled = isIrrigatingAt(zone.id, Date.now());
        const next: ValveState = zone.valveState === 'IRRIGATING' ? 'IDLE' : scheduled ? 'IRRIGATING' : 'IRRIGATING';
        db.setValveState(zone.id, next);
        this.emit({ type: 'ZONE_STATE', zoneId: zone.id, valveState: next });
      }
    }

    // ~8% of ticks: a controller changes status.
    if (rng.chance(0.08)) {
      const controller = rng.pick(db.controllers);
      const next = rng.weighted<DeviceStatus>([
        ['ONLINE', 6],
        ['DEGRADED', 3],
        ['OFFLINE', 1],
      ]);
      if (next !== controller.status) {
        db.setControllerStatus(controller.id, next);
        this.emit({ type: 'CONTROLLER_STATUS', controllerId: controller.id, status: next });
      }
    }

    // ~10% of ticks: a fresh alarm.
    if (rng.chance(0.1)) {
      const zone = rng.pick(db.zones);
      const controller = db.controllerForZone(zone.id);
      const template = rng.pick(ANOMALY_CATALOG);
      const zoneScoped = template.type !== 'COMM_LOSS' && template.type !== 'BATTERY_LOW';

      const alarm: Omit<Alarm, 'id'> = {
        siteId: zone.siteId,
        controllerId: zoneScoped ? null : (controller?.id ?? null),
        zoneId: zoneScoped ? zone.id : null,
        severity: template.severity,
        type: template.type,
        message: zoneScoped
          ? `${template.message} on ${zone.name}`
          : `${template.message} — ${controller?.name ?? 'controller'}`,
        raisedAt: new Date().toISOString(),
        acknowledgedAt: null,
        acknowledgedBy: null,
      };

      this.emit({ type: 'ALARM_RAISED', alarm: db.raiseAlarm(alarm) });
    }
  }
}

export const eventStream = new EventStream();

/** Convenience wrapper matching the signature in ASSIGNMENT.md §6.3. */
export function subscribe(handler: Handler): () => void {
  return eventStream.subscribe(handler);
}

/** Create an isolated stream for tests — no outages, no shared state. */
export function createTestStream(options: StreamOptions = {}): EventStream {
  return new EventStream({ outageEveryMs: 0, ...options });
}

export type { EventStream };
