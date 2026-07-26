/**
 * The mutable in-memory store.
 *
 * `seed.ts` produces an immutable snapshot; this module holds the copy that
 * commands, acknowledgements and stream events mutate. It resets on page
 * reload — that is intentional, so you always start from a known state.
 */

import { generateDataset, SEED, type Dataset } from './seed';
import type { Alarm, Controller, DeviceStatus, Program, Site, ValveState, Zone } from './types';

class Database {
  sites: Site[] = [];
  controllers: Controller[] = [];
  zones: Zone[] = [];
  alarms: Alarm[] = [];
  programs: Program[] = [];

  private nextAlarmId = 9000;
  private nextProgramId = 9000;

  constructor(seed: string = SEED) {
    this.load(generateDataset(seed));
  }

  private load(dataset: Dataset): void {
    this.sites = dataset.sites;
    this.controllers = dataset.controllers;
    this.zones = dataset.zones;
    this.alarms = dataset.alarms;
    this.programs = dataset.programs;
  }

  reset(seed: string = SEED): void {
    this.load(generateDataset(seed));
    this.nextAlarmId = 9000;
    this.nextProgramId = 9000;
  }

  /* -------------------------------------------------------------- */
  /* Lookups                                                         */
  /* -------------------------------------------------------------- */

  site(id: string): Site | undefined {
    return this.sites.find((s) => s.id === id);
  }

  zone(id: string): Zone | undefined {
    return this.zones.find((z) => z.id === id);
  }

  controller(id: string): Controller | undefined {
    return this.controllers.find((c) => c.id === id);
  }

  controllerForZone(zoneId: string): Controller | undefined {
    const zone = this.zone(zoneId);
    return zone ? this.controller(zone.controllerId) : undefined;
  }

  zonesForSite(siteId: string): Zone[] {
    return this.zones.filter((z) => z.siteId === siteId);
  }

  controllersForSite(siteId: string): Controller[] {
    return this.controllers.filter((c) => c.siteId === siteId);
  }

  alarmsForSite(siteId: string): Alarm[] {
    return this.alarms.filter((a) => a.siteId === siteId);
  }

  programsForSite(siteId: string): Program[] {
    return this.programs.filter((p) => p.siteId === siteId);
  }

  openAlarmCount(siteId: string): number {
    return this.alarms.filter((a) => a.siteId === siteId && a.acknowledgedAt === null).length;
  }

  /* -------------------------------------------------------------- */
  /* Mutations                                                       */
  /* -------------------------------------------------------------- */

  setValveState(zoneId: string, valveState: ValveState): Zone | undefined {
    const zone = this.zone(zoneId);
    if (!zone) return undefined;

    zone.valveState = valveState;

    if (valveState === 'IRRIGATING') {
      zone.irrigationStartedAt = new Date().toISOString();
      zone.flowGpm = Number((zone.nominalFlowGpm * 0.96).toFixed(1));
      zone.pressurePsi = Number((zone.pressurePsi * 0.72).toFixed(1));
    } else {
      zone.irrigationStartedAt = null;
      zone.flowGpm = 0;
      if (valveState === 'IDLE') {
        zone.pressurePsi = Number(Math.min(82, zone.pressurePsi / 0.72).toFixed(1));
      }
    }

    return zone;
  }

  setControllerStatus(controllerId: string, status: DeviceStatus): Controller | undefined {
    const controller = this.controller(controllerId);
    if (!controller) return undefined;

    controller.status = status;
    if (status !== 'OFFLINE') controller.lastSeenAt = new Date().toISOString();

    // A controller going offline takes its zones' live values with it.
    if (status === 'OFFLINE') {
      this.zones
        .filter((z) => z.controllerId === controllerId)
        .forEach((z) => {
          z.flowGpm = 0;
          z.pressurePsi = 0;
          if (z.valveState === 'IRRIGATING') {
            z.valveState = 'IDLE';
            z.irrigationStartedAt = null;
          }
        });
    }

    return controller;
  }

  updateTelemetry(
    zoneId: string,
    values: Pick<Zone, 'flowGpm' | 'pressurePsi' | 'soilMoisturePct'>,
  ): Zone | undefined {
    const zone = this.zone(zoneId);
    if (!zone) return undefined;
    Object.assign(zone, values);
    return zone;
  }

  acknowledgeAlarm(alarmId: string, by = 'operator'): Alarm | undefined {
    const alarm = this.alarms.find((a) => a.id === alarmId);
    if (!alarm) return undefined;
    if (alarm.acknowledgedAt === null) {
      alarm.acknowledgedAt = new Date().toISOString();
      alarm.acknowledgedBy = by;
    }
    return alarm;
  }

  raiseAlarm(alarm: Omit<Alarm, 'id'>): Alarm {
    this.nextAlarmId += 1;
    const created: Alarm = { ...alarm, id: `alarm-${this.nextAlarmId}` };
    this.alarms.unshift(created);
    return created;
  }

  createProgram(program: Omit<Program, 'id'>): Program {
    this.nextProgramId += 1;
    const created: Program = { ...program, id: `prog-${this.nextProgramId}` };
    this.programs.push(created);
    return created;
  }

  programNameTaken(siteId: string, name: string): boolean {
    const normalised = name.trim().toLowerCase();
    return this.programs.some((p) => p.siteId === siteId && p.name.trim().toLowerCase() === normalised);
  }
}

export const db = new Database();
export type { Database };
