/**
 * MSW request handlers.
 *
 * Latency and failure rates are part of the assignment, not an accident.
 * Do not soften them — if you think you have found a bug here, note it in
 * DECISIONS.md rather than patching it.
 */

import { HttpResponse, http, delay } from 'msw';
import { db } from './db';
import { generateTelemetry } from './telemetry';
import type {
  Alarm,
  CommandAction,
  Controller,
  Paginated,
  Program,
  Severity,
  Site,
  TelemetryRange,
} from './types';

/* ------------------------------------------------------------------ */
/* Tunables — documented in ASSIGNMENT.md §6.3                         */
/* ------------------------------------------------------------------ */

export interface MockConfig {
  readLatencyMs: readonly [number, number];
  commandLatencyMs: readonly [number, number];
  readFailureRate: number;
  commandFailureRate: number;
}

const DEFAULT_CONFIG: MockConfig = {
  readLatencyMs: [200, 600],
  commandLatencyMs: [1500, 3000],
  readFailureRate: 0.1,
  commandFailureRate: 0.2,
};

export const MOCK_CONFIG: MockConfig = { ...DEFAULT_CONFIG };

/**
 * Override latency and failure behaviour — intended for tests.
 *
 * Random failures make a test suite flaky, so `src/test/setup.ts` zeroes the
 * failure rates and shortens latency by default. When you want to test a
 * failure path, force it explicitly:
 *
 *   configureMocks({ commandFailureRate: 1 });   // every command fails
 *   configureMocks({ readFailureRate: 1 });      // every read 500s
 *
 * Do NOT call this from application code. The rates the app runs against in
 * the browser are fixed at 10% / 20% and are part of the assignment.
 */
export function configureMocks(overrides: Partial<MockConfig>): void {
  Object.assign(MOCK_CONFIG, overrides);
}

/** Restore the browser defaults (10% reads, 20% commands, real latency). */
export function resetMockConfig(): void {
  Object.assign(MOCK_CONFIG, DEFAULT_CONFIG);
}

const randomBetween = ([min, max]: readonly [number, number]): number =>
  min + Math.random() * (max - min);

/** Failures are genuinely random — that is the point. */
const rolledFailure = (rate: number): boolean => Math.random() < rate;

async function readDelay(): Promise<void> {
  await delay(randomBetween(MOCK_CONFIG.readLatencyMs));
}

const serverError = () =>
  HttpResponse.json(
    { code: 'INTERNAL_ERROR', message: 'Upstream SCADA poller timed out. Please retry.' },
    { status: 500 },
  );

const notFound = (what: string) =>
  HttpResponse.json({ code: 'NOT_FOUND', message: `${what} not found` }, { status: 404 });

function paginate<T>(items: T[], page: number, pageSize: number): Paginated<T> {
  const start = (page - 1) * pageSize;
  return {
    data: items.slice(start, start + pageSize),
    total: items.length,
    page,
    pageSize,
  };
}

/** Read a repeated query param: ?region[]=a&region[]=b or ?region=a&region=b */
function multi(url: URL, key: string): string[] {
  const values = [...url.searchParams.getAll(key), ...url.searchParams.getAll(`${key}[]`)];
  return values.flatMap((v) => v.split(',')).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Derived shapes returned by the sites list                           */
/* ------------------------------------------------------------------ */

export interface SiteListRow extends Site {
  controllerCounts: { MC_EDGE: number; ACE3600: number; RIO_XTR: number; total: number };
  onlinePct: number;
  openAlarms: number;
  criticalAlarms: number;
  zoneCount: number;
  irrigatingZoneCount: number;
  lastCommsAt: string | null;
}

function buildSiteRow(site: Site): SiteListRow {
  const controllers = db.controllersForSite(site.id);
  const zones = db.zonesForSite(site.id);
  const alarms = db.alarmsForSite(site.id).filter((a) => a.acknowledgedAt === null);
  const online = controllers.filter((c) => c.status === 'ONLINE').length;

  const counts = controllers.reduce(
    (acc, c) => {
      acc[c.type] += 1;
      acc.total += 1;
      return acc;
    },
    { MC_EDGE: 0, ACE3600: 0, RIO_XTR: 0, total: 0 },
  );

  const lastComms = controllers.reduce<string | null>(
    (latest, c) => (latest === null || c.lastSeenAt > latest ? c.lastSeenAt : latest),
    null,
  );

  return {
    ...site,
    controllerCounts: counts,
    onlinePct: counts.total === 0 ? 0 : Math.round((online / counts.total) * 100),
    openAlarms: alarms.length,
    criticalAlarms: alarms.filter((a) => a.severity === 'CRITICAL').length,
    zoneCount: zones.length,
    irrigatingZoneCount: zones.filter((z) => z.valveState === 'IRRIGATING').length,
    lastCommsAt: lastComms,
  };
}

type SortKey = 'name' | 'region' | 'acres' | 'onlinePct' | 'openAlarms' | 'lastCommsAt' | 'zoneCount';

const SORTERS: Record<SortKey, (a: SiteListRow, b: SiteListRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  region: (a, b) => a.region.localeCompare(b.region),
  acres: (a, b) => a.acres - b.acres,
  onlinePct: (a, b) => a.onlinePct - b.onlinePct,
  openAlarms: (a, b) => a.openAlarms - b.openAlarms,
  zoneCount: (a, b) => a.zoneCount - b.zoneCount,
  lastCommsAt: (a, b) => (a.lastCommsAt ?? '').localeCompare(b.lastCommsAt ?? ''),
};

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

export const handlers = [
  /* ---- Summary for the overview screen ------------------------- */
  http.get('/api/summary', async () => {
    await readDelay();
    if (rolledFailure(MOCK_CONFIG.readFailureRate)) return serverError();

    const controllers = db.controllers;
    const zones = db.zones;
    const openAlarms = db.alarms.filter((a) => a.acknowledgedAt === null);
    const irrigating = zones.filter((z) => z.valveState === 'IRRIGATING');
    const sitesWithOnline = new Set(
      controllers.filter((c) => c.status !== 'OFFLINE').map((c) => c.siteId),
    );

    return HttpResponse.json({
      sitesTotal: db.sites.length,
      sitesOnline: sitesWithOnline.size,
      controllersOnline: controllers.filter((c) => c.status === 'ONLINE').length,
      controllersTotal: controllers.length,
      zonesIrrigating: irrigating.length,
      zonesTotal: zones.length,
      totalFlowGpm: Number(irrigating.reduce((sum, z) => sum + z.flowGpm, 0).toFixed(1)),
      openCriticalAlarms: openAlarms.filter((a) => a.severity === 'CRITICAL').length,
      openAlarmsTotal: openAlarms.length,
      // Rough integral of today's irrigation. Good enough for a KPI tile.
      waterUsedTodayGallons: Math.round(
        irrigating.reduce((sum, z) => {
          const startedAt = z.irrigationStartedAt ? Date.parse(z.irrigationStartedAt) : Date.now();
          const minutes = Math.max(0, (Date.now() - startedAt) / 60_000);
          return sum + z.flowGpm * minutes;
        }, 0),
      ),
    });
  }),

  /* ---- Sites list ---------------------------------------------- */
  http.get('/api/sites', async ({ request }) => {
    await readDelay();
    if (rolledFailure(MOCK_CONFIG.readFailureRate)) return serverError();

    const url = new URL(request.url);
    const search = (url.searchParams.get('search') ?? '').trim().toLowerCase();
    const regions = multi(url, 'region');
    const types = multi(url, 'type');
    const statuses = multi(url, 'status');
    const hasAlarms = url.searchParams.get('hasAlarms');
    const sort = (url.searchParams.get('sort') ?? 'name') as SortKey;
    const order = url.searchParams.get('order') === 'desc' ? -1 : 1;
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 20)));

    let rows = db.sites.map(buildSiteRow);

    if (search) {
      rows = rows.filter(
        (r) => r.name.toLowerCase().includes(search) || r.region.toLowerCase().includes(search),
      );
    }
    if (regions.length > 0) rows = rows.filter((r) => regions.includes(r.region));
    if (types.length > 0) {
      rows = rows.filter((r) =>
        types.some((t) => (r.controllerCounts[t as keyof typeof r.controllerCounts] ?? 0) > 0),
      );
    }
    if (statuses.length > 0) {
      rows = rows.filter((r) =>
        db.controllersForSite(r.id).some((c) => statuses.includes(c.status)),
      );
    }
    if (hasAlarms === 'true') rows = rows.filter((r) => r.openAlarms > 0);
    if (hasAlarms === 'false') rows = rows.filter((r) => r.openAlarms === 0);

    const sorter = SORTERS[sort] ?? SORTERS.name;
    rows.sort((a, b) => sorter(a, b) * order);

    return HttpResponse.json(paginate(rows, page, pageSize));
  }),

  /* ---- Filter facets (so you don't hard-code region lists) ----- */
  http.get('/api/facets', async () => {
    await readDelay();
    return HttpResponse.json({
      regions: [...new Set(db.sites.map((s) => s.region))].sort(),
      controllerTypes: ['MC_EDGE', 'ACE3600', 'RIO_XTR'],
      deviceStatuses: ['ONLINE', 'DEGRADED', 'OFFLINE'],
      severities: ['CRITICAL', 'WARNING', 'INFO'],
      crops: [...new Set(db.zones.map((z) => z.crop))].sort(),
    });
  }),

  /* ---- Single site --------------------------------------------- */
  http.get('/api/sites/:siteId', async ({ params }) => {
    await readDelay();
    if (rolledFailure(MOCK_CONFIG.readFailureRate)) return serverError();

    const site = db.site(String(params.siteId));
    return site ? HttpResponse.json(buildSiteRow(site)) : notFound('Site');
  }),

  http.get('/api/sites/:siteId/controllers', async ({ params }) => {
    await readDelay();
    if (rolledFailure(MOCK_CONFIG.readFailureRate)) return serverError();

    const siteId = String(params.siteId);
    if (!db.site(siteId)) return notFound('Site');

    const data: Controller[] = db.controllersForSite(siteId);
    return HttpResponse.json({ data, total: data.length, page: 1, pageSize: data.length });
  }),

  http.get('/api/sites/:siteId/zones', async ({ params }) => {
    await readDelay();
    if (rolledFailure(MOCK_CONFIG.readFailureRate)) return serverError();

    const siteId = String(params.siteId);
    if (!db.site(siteId)) return notFound('Site');

    const data = db.zonesForSite(siteId);
    return HttpResponse.json({ data, total: data.length, page: 1, pageSize: data.length });
  }),

  /* ---- Alarms -------------------------------------------------- */
  http.get('/api/sites/:siteId/alarms', async ({ params, request }) => {
    await readDelay();
    if (rolledFailure(MOCK_CONFIG.readFailureRate)) return serverError();

    const siteId = String(params.siteId);
    if (!db.site(siteId)) return notFound('Site');

    const url = new URL(request.url);
    const severities = multi(url, 'severity') as Severity[];
    const acknowledged = url.searchParams.get('acknowledged');

    let data: Alarm[] = db.alarmsForSite(siteId);
    if (severities.length > 0) data = data.filter((a) => severities.includes(a.severity));
    if (acknowledged === 'true') data = data.filter((a) => a.acknowledgedAt !== null);
    if (acknowledged === 'false') data = data.filter((a) => a.acknowledgedAt === null);

    data = [...data].sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
    return HttpResponse.json({ data, total: data.length, page: 1, pageSize: data.length });
  }),

  /** Recent alarms across all sites — for the overview feed. */
  http.get('/api/alarms', async ({ request }) => {
    await readDelay();
    if (rolledFailure(MOCK_CONFIG.readFailureRate)) return serverError();

    const url = new URL(request.url);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    const severities = multi(url, 'severity') as Severity[];
    const acknowledged = url.searchParams.get('acknowledged');

    let data = [...db.alarms];
    if (severities.length > 0) data = data.filter((a) => severities.includes(a.severity));
    if (acknowledged === 'false') data = data.filter((a) => a.acknowledgedAt === null);
    if (acknowledged === 'true') data = data.filter((a) => a.acknowledgedAt !== null);

    data.sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
    return HttpResponse.json({
      data: data.slice(0, limit),
      total: data.length,
      page: 1,
      pageSize: limit,
    });
  }),

  http.post('/api/alarms/:alarmId/ack', async ({ params }) => {
    await delay(randomBetween([300, 900]));
    if (rolledFailure(MOCK_CONFIG.readFailureRate)) return serverError();

    const alarm = db.acknowledgeAlarm(String(params.alarmId));
    return alarm ? HttpResponse.json(alarm) : notFound('Alarm');
  }),

  /* ---- Zone telemetry ------------------------------------------ */
  http.get('/api/zones/:zoneId/telemetry', async ({ params, request }) => {
    await readDelay();
    if (rolledFailure(MOCK_CONFIG.readFailureRate)) return serverError();

    const zoneId = String(params.zoneId);
    if (!db.zone(zoneId)) return notFound('Zone');

    const url = new URL(request.url);
    const range = (url.searchParams.get('range') ?? '24h') as TelemetryRange;
    if (!['1h', '6h', '24h', '7d'].includes(range)) {
      return HttpResponse.json(
        { code: 'BAD_REQUEST', message: `Unsupported range '${range}'` },
        { status: 400 },
      );
    }

    // 7d is ~10,000 points. This is deliberate. Do not paginate it away.
    const data = generateTelemetry(zoneId, range);
    return HttpResponse.json({ zoneId, range, data, total: data.length });
  }),

  /* ---- Zone command -------------------------------------------- */
  http.post('/api/zones/:zoneId/command', async ({ params, request }) => {
    const zoneId = String(params.zoneId);
    const body = (await request.json()) as { action?: CommandAction } | null;
    const action = body?.action;

    // Slow on purpose: this is what your optimistic UI has to cover.
    await delay(randomBetween(MOCK_CONFIG.commandLatencyMs));

    const zone = db.zone(zoneId);
    if (!zone) return notFound('Zone');

    if (action !== 'START' && action !== 'STOP') {
      return HttpResponse.json(
        { errors: { action: "action must be 'START' or 'STOP'" } },
        { status: 422 },
      );
    }

    const controller = db.controllerForZone(zoneId);

    // An offline controller can never be commanded.
    if (!controller || controller.status === 'OFFLINE') {
      return HttpResponse.json(
        {
          code: 'DEVICE_UNREACHABLE',
          message: `${controller?.name ?? 'Controller'} is offline — command not delivered`,
        },
        { status: 409 },
      );
    }

    // ...and sometimes the radio just doesn't get through.
    if (rolledFailure(MOCK_CONFIG.commandFailureRate)) {
      return HttpResponse.json(
        {
          code: 'DEVICE_UNREACHABLE',
          message: `No acknowledgement from ${controller.name} after 3 retries`,
        },
        { status: 409 },
      );
    }

    const updated = db.setValveState(zoneId, action === 'START' ? 'IRRIGATING' : 'IDLE');
    return HttpResponse.json(updated);
  }),

  /* ---- Programs ------------------------------------------------ */
  http.get('/api/sites/:siteId/programs', async ({ params }) => {
    await readDelay();
    if (rolledFailure(MOCK_CONFIG.readFailureRate)) return serverError();

    const siteId = String(params.siteId);
    if (!db.site(siteId)) return notFound('Site');

    const data = db.programsForSite(siteId);
    return HttpResponse.json({ data, total: data.length, page: 1, pageSize: data.length });
  }),

  http.post('/api/programs', async ({ request }) => {
    await delay(randomBetween([700, 1600]));

    const body = (await request.json()) as Partial<Program> | null;
    const errors: Record<string, string> = {};

    const name = body?.name?.trim() ?? '';
    if (name.length < 3 || name.length > 48) {
      errors.name = 'Name must be between 3 and 48 characters';
    }
    if (!body?.siteId || !db.site(body.siteId)) {
      errors.siteId = 'Unknown site';
    }
    if (!body?.zoneIds || body.zoneIds.length === 0) {
      errors.zoneIds = 'Select at least one zone';
    }
    if (!body?.daysOfWeek || body.daysOfWeek.length === 0) {
      errors.daysOfWeek = 'Select at least one day';
    }
    if (!body?.startTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.startTime)) {
      errors.startTime = 'Start time must be HH:mm';
    }
    if (body?.mode === 'TIME') {
      const minutes = body.durationMinutes;
      if (typeof minutes !== 'number' || minutes < 1 || minutes > 720) {
        errors.durationMinutes = 'Duration must be between 1 and 720 minutes';
      }
    } else if (body?.mode === 'VOLUME') {
      const gallons = body.targetVolumeGallons;
      if (typeof gallons !== 'number' || gallons <= 0) {
        errors.targetVolumeGallons = 'Target volume must be greater than zero';
      }
    } else {
      errors.mode = "Mode must be 'TIME' or 'VOLUME'";
    }

    // The field error the assignment asks you to surface on the form.
    if (!errors.name && body?.siteId && db.programNameTaken(body.siteId, name)) {
      errors.name = 'A program with this name already exists';
    }

    if (Object.keys(errors).length > 0) {
      return HttpResponse.json({ errors }, { status: 422 });
    }

    const created = db.createProgram({
      siteId: body!.siteId!,
      name,
      enabled: body!.enabled ?? true,
      mode: body!.mode!,
      zoneIds: body!.zoneIds!,
      daysOfWeek: body!.daysOfWeek!,
      startTime: body!.startTime!,
      ...(body!.mode === 'TIME'
        ? { durationMinutes: body!.durationMinutes }
        : { targetVolumeGallons: body!.targetVolumeGallons }),
    });

    return HttpResponse.json(created, { status: 201 });
  }),

  /* ---- Escape hatch for tests --------------------------------- */
  http.post('/api/__reset', async () => {
    db.reset();
    return HttpResponse.json({ ok: true });
  }),
];
