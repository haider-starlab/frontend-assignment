/**
 * The API contract. These types describe what the mock endpoints return;
 * they are the same shapes documented in ASSIGNMENT.md §6.1.
 *
 * You may import these into your application code.
 */

export type ControllerType = 'MC_EDGE' | 'ACE3600' | 'RIO_XTR';
export type DeviceStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE';
export type ValveState = 'IRRIGATING' | 'IDLE' | 'FAULT';
export type Severity = 'CRITICAL' | 'WARNING' | 'INFO';

export type AlarmType =
  | 'LOW_PRESSURE'
  | 'HIGH_PRESSURE'
  | 'COMM_LOSS'
  | 'LEAK_SUSPECTED'
  | 'PUMP_FAULT'
  | 'BATTERY_LOW'
  | 'FLOW_ANOMALY';

export interface Site {
  id: string;
  name: string;
  region: string;
  acres: number;
  /** IANA timezone, e.g. 'America/Los_Angeles'. Sites are NOT all in one zone. */
  timezone: string;
  coordinates: { lat: number; lng: number };
}

export interface Controller {
  id: string;
  siteId: string;
  name: string;
  type: ControllerType;
  status: DeviceStatus;
  firmware: string;
  /** null for mains-powered units (MC Edge, ACE3600). */
  batteryVolts: number | null;
  /** Received signal strength, dBm. null for wired units. */
  rssiDbm: number | null;
  lastSeenAt: string;
}

export interface Zone {
  id: string;
  siteId: string;
  controllerId: string;
  name: string;
  crop: string;
  areaAcres: number;
  valveState: ValveState;
  /** Design flow for this zone when fully open. */
  nominalFlowGpm: number;
  flowGpm: number;
  pressurePsi: number;
  soilMoisturePct: number;
  irrigationStartedAt: string | null;
}

export interface Alarm {
  id: string;
  siteId: string;
  controllerId: string | null;
  zoneId: string | null;
  severity: Severity;
  type: AlarmType;
  message: string;
  raisedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

export interface Program {
  id: string;
  siteId: string;
  name: string;
  enabled: boolean;
  mode: 'TIME' | 'VOLUME';
  zoneIds: string[];
  /** 0 = Sunday. */
  daysOfWeek: number[];
  /** 'HH:mm', in the site's local time. */
  startTime: string;
  durationMinutes?: number;
  targetVolumeGallons?: number;
}

export interface TelemetryPoint {
  t: string;
  flowGpm: number;
  pressurePsi: number;
  soilMoisturePct: number;
}

export type TelemetryRange = '1h' | '6h' | '24h' | '7d';

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type CommandAction = 'START' | 'STOP';

export interface ApiError {
  code: string;
  message: string;
}

export interface FieldValidationError {
  errors: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Event stream                                                        */
/* ------------------------------------------------------------------ */

export type StreamEvent =
  | {
      type: 'TELEMETRY';
      zoneId: string;
      flowGpm: number;
      pressurePsi: number;
      soilMoisturePct: number;
      t: string;
    }
  | { type: 'ALARM_RAISED'; alarm: Alarm }
  | { type: 'ZONE_STATE'; zoneId: string; valveState: ValveState }
  | { type: 'CONTROLLER_STATUS'; controllerId: string; status: DeviceStatus }
  /** Emitted when the simulated transport drops. No events arrive until CONNECTED. */
  | { type: 'DISCONNECTED'; reason: string }
  | { type: 'CONNECTED' };
