/**
 * Smoke tests for the mock layer itself.
 *
 * These exist so you can confirm the test harness works before you write
 * anything. They do NOT count toward the 5-8 tests the assignment asks
 * for — those should cover YOUR components and hooks.
 */

import { describe, expect, it } from 'vitest';
import { db } from '../db';
import { configureMocks } from '../handlers';
import { generateDataset, TARGET_COUNTS } from '../seed';
import { generateTelemetry, RANGE_MINUTES } from '../telemetry';
import { createTestStream } from '../stream';
import type { Paginated, StreamEvent } from '../types';
import type { SiteListRow } from '../handlers';

describe('seed data', () => {
  it('generates the documented volumes', () => {
    const data = generateDataset();
    expect(data.sites).toHaveLength(TARGET_COUNTS.sites);
    expect(data.controllers).toHaveLength(TARGET_COUNTS.controllers);
    expect(data.zones).toHaveLength(TARGET_COUNTS.zones);
    expect(data.alarms).toHaveLength(TARGET_COUNTS.alarms);
  });

  it('is deterministic for a fixed seed and clock', () => {
    const at = Date.UTC(2026, 0, 1, 12, 0);
    expect(generateDataset('branif-fieldops-v1', at)).toEqual(
      generateDataset('branif-fieldops-v1', at),
    );
  });

  it('spans multiple regions and timezones', () => {
    const { sites } = generateDataset();
    expect(new Set(sites.map((s) => s.region)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(sites.map((s) => s.timezone)).size).toBeGreaterThanOrEqual(3);
  });
});

describe('telemetry', () => {
  it('returns one point per minute for each range', () => {
    for (const range of ['1h', '6h', '24h', '7d'] as const) {
      expect(generateTelemetry('zone-0007', range)).toHaveLength(RANGE_MINUTES[range]);
    }
  });

  it('shows line pressure sagging while the valve is open', () => {
    const series = generateTelemetry('zone-0007', '24h', Date.UTC(2026, 6, 26, 14, 30));
    const open = series.filter((p) => p.flowGpm > 0);
    const closed = series.filter((p) => p.flowGpm === 0);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    expect(open.length).toBeGreaterThan(0);
    expect(mean(open.map((p) => p.pressurePsi))).toBeLessThan(mean(closed.map((p) => p.pressurePsi)));
  });
});

describe('HTTP handlers', () => {
  it('paginates and sorts the sites list', async () => {
    const res = await fetch('/api/sites?page=2&pageSize=10&sort=acres&order=desc');
    expect(res.ok).toBe(true);

    const body = (await res.json()) as Paginated<SiteListRow>;
    expect(body.page).toBe(2);
    expect(body.data).toHaveLength(10);
    expect(body.total).toBe(TARGET_COUNTS.sites);

    const acres = body.data.map((s) => s.acres);
    expect([...acres].sort((a, b) => b - a)).toEqual(acres);
  });

  it('refuses commands to a zone whose controller is offline', async () => {
    const offline = db.controllers.find((c) => c.status === 'OFFLINE');
    const zone = db.zones.find((z) => z.controllerId === offline?.id);
    expect(zone).toBeDefined();

    const res = await fetch(`/api/zones/${zone!.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'START' }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'DEVICE_UNREACHABLE' });
  }, 10_000);

  it('can be forced to fail every command — the pattern for your own tests', async () => {
    configureMocks({ commandFailureRate: 1 });

    // MC Edge gateways host no zones, so find a controller that does.
    const zone = db.zones.find((z) => db.controller(z.controllerId)?.status === 'ONLINE')!;
    expect(zone).toBeDefined();

    const res = await fetch(`/api/zones/${zone.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'START' }),
    });

    expect(res.status).toBe(409);
    // The store must be untouched — this is what your rollback has to restore to.
    expect(db.zone(zone.id)?.valveState).toBe(zone.valveState);
  });

  it('rejects a duplicate program name with a 422 field error', async () => {
    const existing = db.programs[0]!;
    const res = await fetch('/api/programs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteId: existing.siteId,
        name: existing.name,
        mode: 'TIME',
        zoneIds: db.zonesForSite(existing.siteId).slice(0, 1).map((z) => z.id),
        daysOfWeek: [1],
        startTime: '06:00',
        durationMinutes: 60,
        enabled: true,
      }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Record<string, string> };
    expect(body.errors.name).toMatch(/already exists/i);
  });
});

describe('event stream', () => {
  it('reports connection state and delivers events to subscribers', async () => {
    const stream = createTestStream({ tickMs: [10, 20] });
    const received: StreamEvent[] = [];
    const unsubscribe = stream.subscribe((event) => received.push(event));

    expect(received[0]).toEqual({ type: 'CONNECTED' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    expect(received.length).toBeGreaterThan(1);
    expect(received.some((e) => e.type === 'TELEMETRY')).toBe(true);
  });

  it('stops delivering after unsubscribe', async () => {
    const stream = createTestStream({ tickMs: [10, 20] });
    const received: StreamEvent[] = [];
    const unsubscribe = stream.subscribe((e) => received.push(e));

    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    const countAtUnsubscribe = received.length;

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received.length).toBe(countAtUnsubscribe);
  });
});
