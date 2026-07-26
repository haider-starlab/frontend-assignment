/**
 * Deterministic dataset generation.
 *
 * Everything below is derived from SEED. Change nothing here — if two
 * candidates generate different data, their submissions stop being
 * comparable.
 */

import { createRng, type Rng } from './rng';
import { isIrrigatingAt } from './telemetry';
import type {
  Alarm,
  AlarmType,
  Controller,
  ControllerType,
  DeviceStatus,
  Program,
  Severity,
  Site,
  Zone,
} from './types';

export const SEED = 'branif-fieldops-v1';

export const TARGET_COUNTS = {
  sites: 40,
  controllers: 600,
  zones: 900,
  alarms: 250,
  programs: 60,
} as const;

const REGIONS: ReadonlyArray<{ name: string; timezone: string; lat: number; lng: number }> = [
  { name: 'Central Valley, CA', timezone: 'America/Los_Angeles', lat: 36.75, lng: -119.77 },
  { name: 'Willamette Valley, OR', timezone: 'America/Los_Angeles', lat: 44.94, lng: -123.04 },
  { name: 'Yakima Valley, WA', timezone: 'America/Los_Angeles', lat: 46.6, lng: -120.51 },
  { name: 'Sunraysia, VIC', timezone: 'Australia/Melbourne', lat: -34.28, lng: 142.16 },
  { name: 'Central Otago, NZ', timezone: 'Pacific/Auckland', lat: -45.03, lng: 169.19 },
  { name: 'Mendoza, AR', timezone: 'America/Argentina/Mendoza', lat: -32.89, lng: -68.85 },
];

const SITE_PREFIX = [
  'Stone Ridge',
  'Willow Creek',
  'Dry Gulch',
  'Blue Heron',
  'Cottonwood',
  'Red Bluff',
  'Silver Basin',
  'Tule Flats',
  'Hawthorn',
  'Coyote Wells',
  'Manzanita',
  'Kestrel',
  'Sandhill',
  'Elder Grove',
  'Quail Run',
  'Sycamore',
  'Ironwood',
  'Larkspur',
  'Pinnacle',
  'Sagebrush',
];
const SITE_SUFFIX = ['Ranch', 'Farms', 'Orchards', 'Vineyards', 'Estate', 'Fields'];

const CROPS = [
  'Almonds',
  'Pistachios',
  'Wine Grapes',
  'Blueberries',
  'Table Grapes',
  'Cherries',
  'Hops',
  'Walnuts',
  'Olives',
  'Apples',
  'Alfalfa',
  'Sweet Corn',
];

const FIRMWARE: Record<ControllerType, readonly string[]> = {
  MC_EDGE: ['5.2.1', '5.3.0', '5.3.4'],
  ACE3600: ['21.10', '21.40', '22.00'],
  RIO_XTR: ['3.8.2', '3.9.0', '3.9.1'],
};

const ALARM_CATALOG: ReadonlyArray<{
  type: AlarmType;
  severity: Severity;
  weight: number;
  message: (ctx: { site: string; zone?: string; controller?: string }) => string;
}> = [
  {
    type: 'LOW_PRESSURE',
    severity: 'CRITICAL',
    weight: 16,
    message: (c) => `Pressure below 32 PSI setpoint on ${c.zone ?? 'unknown zone'}`,
  },
  {
    type: 'HIGH_PRESSURE',
    severity: 'WARNING',
    weight: 10,
    message: (c) => `Pressure exceeded 95 PSI on ${c.zone ?? 'unknown zone'}`,
  },
  {
    type: 'COMM_LOSS',
    severity: 'CRITICAL',
    weight: 14,
    message: (c) => `No response from ${c.controller ?? 'controller'} for 3 polling cycles`,
  },
  {
    type: 'LEAK_SUSPECTED',
    severity: 'CRITICAL',
    weight: 8,
    message: (c) => `Flow detected on ${c.zone ?? 'zone'} with valve commanded closed`,
  },
  {
    type: 'PUMP_FAULT',
    severity: 'CRITICAL',
    weight: 7,
    message: () => 'VFD reported fault code F031 — motor overload',
  },
  {
    type: 'BATTERY_LOW',
    severity: 'WARNING',
    weight: 20,
    message: (c) => `Battery at 11.4 V on ${c.controller ?? 'controller'} — solar charge low`,
  },
  {
    type: 'FLOW_ANOMALY',
    severity: 'WARNING',
    weight: 15,
    message: (c) => `Flow 24% below expected for ${c.zone ?? 'zone'} — check filter`,
  },
  {
    type: 'FLOW_ANOMALY',
    severity: 'INFO',
    weight: 10,
    message: () => 'Filter flush cycle completed normally',
  },
];

const pad = (n: number, width = 3): string => String(n).padStart(width, '0');

function makeSites(rng: Rng): Site[] {
  const usedNames = new Set<string>();
  const sites: Site[] = [];

  for (let i = 0; i < TARGET_COUNTS.sites; i += 1) {
    const region = REGIONS[i % REGIONS.length]!;

    let name = '';
    do {
      name = `${rng.pick(SITE_PREFIX)} ${rng.pick(SITE_SUFFIX)}`;
    } while (usedNames.has(name));
    usedNames.add(name);

    sites.push({
      id: `site-${pad(i + 1)}`,
      name,
      region: region.name,
      acres: rng.int(120, 4800),
      timezone: region.timezone,
      coordinates: {
        lat: Number((region.lat + rng.float(-0.6, 0.6)).toFixed(4)),
        lng: Number((region.lng + rng.float(-0.6, 0.6)).toFixed(4)),
      },
    });
  }

  return sites;
}

/**
 * Distribute a total across `buckets` so that every bucket gets at least
 * `min`, and the total is exact. Keeps counts realistic (big sites, small
 * sites) without drifting away from the documented totals.
 */
function distribute(rng: Rng, total: number, buckets: number, min: number): number[] {
  const counts = Array.from({ length: buckets }, () => min);
  let remaining = total - min * buckets;
  if (remaining < 0) throw new Error('distribute: min * buckets exceeds total');

  const weights = Array.from({ length: buckets }, () => rng.float(0.4, 3));
  const weightTotal = weights.reduce((a, b) => a + b, 0);

  for (let i = 0; i < buckets && remaining > 0; i += 1) {
    const share = Math.min(remaining, Math.round((weights[i]! / weightTotal) * (total - min * buckets)));
    counts[i]! += share;
    remaining -= share;
  }
  let cursor = 0;
  while (remaining > 0) {
    counts[cursor % buckets]! += 1;
    remaining -= 1;
    cursor += 1;
  }
  return counts;
}

function makeControllers(rng: Rng, sites: Site[], now: number): Controller[] {
  const perSite = distribute(rng, TARGET_COUNTS.controllers, sites.length, 3);
  const controllers: Controller[] = [];
  let n = 0;

  sites.forEach((site, siteIndex) => {
    const count = perSite[siteIndex]!;

    for (let i = 0; i < count; i += 1) {
      // Every site gets exactly one MC Edge gateway; the rest are RTUs and
      // remote I/O nodes, weighted toward RIO XT/R as in the field.
      const type: ControllerType =
        i === 0 ? 'MC_EDGE' : rng.weighted<ControllerType>([['RIO_XTR', 7], ['ACE3600', 3]]);

      const status: DeviceStatus = rng.weighted<DeviceStatus>([
        ['ONLINE', 82],
        ['DEGRADED', 10],
        ['OFFLINE', 8],
      ]);

      const solar = type === 'RIO_XTR';
      const staleMinutes =
        status === 'ONLINE' ? rng.int(0, 4) : status === 'DEGRADED' ? rng.int(5, 45) : rng.int(90, 4320);

      n += 1;
      controllers.push({
        id: `ctrl-${pad(n, 4)}`,
        siteId: site.id,
        name:
          type === 'MC_EDGE'
            ? `MC Edge Gateway ${pad(i + 1, 2)}`
            : type === 'ACE3600'
              ? `ACE3600 RTU ${pad(i + 1, 2)}`
              : `RIO XTR ${pad(i + 1, 2)}`,
        type,
        status,
        firmware: rng.pick(FIRMWARE[type]),
        batteryVolts: solar ? Number(rng.float(10.9, 14.1).toFixed(2)) : null,
        rssiDbm: type === 'MC_EDGE' ? null : rng.int(-112, -58),
        lastSeenAt: new Date(now - staleMinutes * 60_000).toISOString(),
      });
    }
  });

  return controllers;
}

function makeZones(rng: Rng, sites: Site[], controllers: Controller[], now: number): Zone[] {
  const bySite = new Map<string, Controller[]>();
  controllers.forEach((c) => {
    const list = bySite.get(c.siteId) ?? [];
    list.push(c);
    bySite.set(c.siteId, list);
  });

  const perSite = distribute(rng, TARGET_COUNTS.zones, sites.length, 4);
  const zones: Zone[] = [];
  let n = 0;

  sites.forEach((site, siteIndex) => {
    const count = perSite[siteIndex]!;
    // Zones hang off RIOs and ACE3600s, not off the gateway.
    const candidates = (bySite.get(site.id) ?? []).filter((c) => c.type !== 'MC_EDGE');
    const hosts = candidates.length > 0 ? candidates : (bySite.get(site.id) ?? []);
    const crop = rng.pick(CROPS);

    for (let i = 0; i < count; i += 1) {
      const controller = hosts[i % hosts.length]!;
      n += 1;
      const id = `zone-${pad(n, 4)}`;

      const nominalFlowGpm = rng.int(45, 620);
      const offline = controller.status === 'OFFLINE';
      const faulted = !offline && rng.chance(0.03);

      // Valve state is derived from the same synthetic schedule the
      // telemetry generator uses, so the chart agrees with the grid.
      const scheduled = !offline && !faulted && isIrrigatingAt(id, now);
      const valveState = faulted ? 'FAULT' : scheduled ? 'IRRIGATING' : 'IDLE';
      const irrigating = valveState === 'IRRIGATING';

      zones.push({
        id,
        siteId: site.id,
        controllerId: controller.id,
        name: `Block ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26) + 1}`,
        crop: rng.chance(0.75) ? crop : rng.pick(CROPS),
        areaAcres: Number(rng.float(2.5, 60).toFixed(1)),
        valveState,
        nominalFlowGpm,
        flowGpm: irrigating ? Number((nominalFlowGpm * rng.float(0.9, 1.05)).toFixed(1)) : 0,
        pressurePsi: offline ? 0 : Number(rng.float(irrigating ? 44 : 58, irrigating ? 62 : 78).toFixed(1)),
        soilMoisturePct: Number(rng.float(14, 38).toFixed(1)),
        irrigationStartedAt: irrigating ? new Date(now - rng.int(4, 160) * 60_000).toISOString() : null,
      });
    }
  });

  return zones;
}

function makeAlarms(rng: Rng, controllers: Controller[], zones: Zone[], now: number): Alarm[] {
  const alarms: Alarm[] = [];
  const catalogWeights = ALARM_CATALOG.map((entry, index) => [index, entry.weight] as const);

  for (let i = 0; i < TARGET_COUNTS.alarms; i += 1) {
    const template = ALARM_CATALOG[rng.weighted(catalogWeights)]!;
    const zone = rng.pick(zones);
    const controller = controllers.find((c) => c.id === zone.controllerId)!;
    const zoneScoped = template.type !== 'COMM_LOSS' && template.type !== 'BATTERY_LOW';

    const ageMinutes = rng.int(1, 20_160); // up to 14 days
    const raisedAt = new Date(now - ageMinutes * 60_000);
    // Older alarms are more likely to have been dealt with.
    const acknowledged = rng.chance(Math.min(0.85, ageMinutes / 6000));

    alarms.push({
      id: `alarm-${pad(i + 1, 4)}`,
      siteId: zone.siteId,
      controllerId: zoneScoped ? null : controller.id,
      zoneId: zoneScoped ? zone.id : null,
      severity: template.severity,
      type: template.type,
      message: template.message({ site: zone.siteId, zone: zone.name, controller: controller.name }),
      raisedAt: raisedAt.toISOString(),
      acknowledgedAt: acknowledged
        ? new Date(raisedAt.getTime() + rng.int(2, 600) * 60_000).toISOString()
        : null,
      acknowledgedBy: acknowledged ? rng.pick(['j.reyes', 'm.okafor', 'a.lindqvist', 's.patel']) : null,
    });
  }

  return alarms.sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
}

function makePrograms(rng: Rng, sites: Site[], zones: Zone[]): Program[] {
  const zonesBySite = new Map<string, Zone[]>();
  zones.forEach((z) => {
    const list = zonesBySite.get(z.siteId) ?? [];
    list.push(z);
    zonesBySite.set(z.siteId, list);
  });

  const programs: Program[] = [];
  const names = ['Morning Set', 'Night Set', 'Deep Soak', 'Fertigation Run', 'Pulse Set', 'Frost Cycle'];
  let n = 0;

  // Spread programs across the first N sites so most sites have 1-2.
  // Two slots are reserved for the guaranteed-conflict fixtures below.
  for (let i = 0; i < TARGET_COUNTS.programs - 2; i += 1) {
    const site = sites[i % sites.length]!;
    const siteZones = zonesBySite.get(site.id) ?? [];
    if (siteZones.length === 0) continue;

    const mode = rng.chance(0.6) ? 'TIME' : 'VOLUME';
    const picked = rng.shuffle(siteZones).slice(0, rng.int(1, Math.min(6, siteZones.length)));
    const startHour = rng.int(0, 23);
    n += 1;

    programs.push({
      id: `prog-${pad(n, 3)}`,
      siteId: site.id,
      name: `${rng.pick(names)} ${pad(rng.int(1, 9), 1)}`,
      enabled: rng.chance(0.8),
      mode,
      zoneIds: picked.map((z) => z.id),
      daysOfWeek: rng.shuffle([0, 1, 2, 3, 4, 5, 6]).slice(0, rng.int(1, 5)).sort(),
      startTime: `${pad(startHour, 2)}:${rng.pick(['00', '15', '30', '45'])}`,
      ...(mode === 'TIME'
        ? { durationMinutes: rng.int(20, 420) }
        : { targetVolumeGallons: rng.int(5_000, 220_000) }),
    });
  }

  // Guarantee at least a few genuine conflicts exist, so candidates can
  // actually exercise overlap detection in the program builder.
  const firstSite = sites[0]!;
  const firstSiteZones = (zonesBySite.get(firstSite.id) ?? []).slice(0, 3).map((z) => z.id);
  if (firstSiteZones.length > 0) {
    programs.push(
      {
        id: 'prog-900',
        siteId: firstSite.id,
        name: 'Overlap Fixture A',
        enabled: true,
        mode: 'TIME',
        zoneIds: firstSiteZones,
        daysOfWeek: [1, 3, 5],
        startTime: '06:00',
        durationMinutes: 180,
      },
      {
        id: 'prog-901',
        siteId: firstSite.id,
        name: 'Overlap Fixture B',
        enabled: true,
        mode: 'VOLUME',
        zoneIds: firstSiteZones.slice(0, 1),
        daysOfWeek: [1, 3],
        startTime: '07:30',
        targetVolumeGallons: 40_000,
      },
    );
  }

  return programs;
}

export interface Dataset {
  sites: Site[];
  controllers: Controller[];
  zones: Zone[];
  alarms: Alarm[];
  programs: Program[];
  generatedAt: string;
}

export function generateDataset(seed: string = SEED, nowMs: number = Date.now()): Dataset {
  const rng = createRng(seed);
  const sites = makeSites(rng);
  const controllers = makeControllers(rng, sites, nowMs);
  const zones = makeZones(rng, sites, controllers, nowMs);
  const alarms = makeAlarms(rng, controllers, zones, nowMs);
  const programs = makePrograms(rng, sites, zones);

  return {
    sites,
    controllers,
    zones,
    alarms,
    programs,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
