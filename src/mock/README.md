# `src/mock/` — do not modify

This folder is the fake backend. It is given to you finished so you can spend
your time on the frontend, and so that every candidate is building against
identical data.

**Please don't change anything in here.** If you think you've found a bug or an
unreasonable constraint, write it in `DECISIONS.md` and work around it — that's
a good signal, and we'd rather read about it than discover a quietly softened
failure rate. We diff this folder against ours during review.

## What you get

| File | What it is |
|---|---|
| `types.ts` | The API contract. Import these into your app freely. |
| `seed.ts` | Deterministic dataset generation. 40 sites, 600 controllers, 900 zones, 250 alarms, 60 programs. |
| `db.ts` | Mutable in-memory store. Resets on page reload. |
| `handlers.ts` | MSW request handlers, including latency and failure injection. |
| `telemetry.ts` | Synthetic time-series, generated on demand. |
| `stream.ts` | Simulated real-time event stream. |
| `rng.ts` | Seeded PRNG. Nothing here is `Math.random()` except the failure rolls. |
| `index.ts` | Barrel export + `startMocks()`. |

## Getting data

`startMocks()` is already called in `src/main.tsx`, so by the time your
components mount, `fetch('/api/...')` is intercepted. Everything is under
`/api`. Use whatever client you like — `fetch`, axios, TanStack Query.

```ts
const res = await fetch('/api/sites?page=1&pageSize=20&sort=name');
const { data, total } = await res.json();
```

### Endpoints

```
GET  /api/summary                          KPI roll-up for the overview
GET  /api/facets                           filter options (regions, crops, ...)
GET  /api/sites                            ?search &region[] &type[] &status[]
                                           &hasAlarms &sort &order &page &pageSize
GET  /api/sites/:siteId
GET  /api/sites/:siteId/controllers
GET  /api/sites/:siteId/zones
GET  /api/sites/:siteId/alarms             ?severity[] &acknowledged
GET  /api/sites/:siteId/programs
GET  /api/alarms                           ?limit &severity[] &acknowledged
POST /api/alarms/:alarmId/ack
GET  /api/zones/:zoneId/telemetry          ?range=1h|6h|24h|7d
POST /api/zones/:zoneId/command            { action: 'START' | 'STOP' }
POST /api/programs
```

List endpoints return `{ data, total, page, pageSize }`.

`/api/sites` and `/api/sites/:id` return a `SiteListRow` — the `Site` fields plus
derived roll-ups (`controllerCounts`, `onlinePct`, `openAlarms`, `zoneCount`,
`irrigatingZoneCount`, `lastCommsAt`). You don't need to compute those yourself.

## The event stream

```ts
import { subscribe } from '@/mock';

const unsubscribe = subscribe((event) => {
  switch (event.type) {
    case 'TELEMETRY':          /* zoneId, flowGpm, pressurePsi, soilMoisturePct, t */ break;
    case 'ZONE_STATE':         /* zoneId, valveState */ break;
    case 'CONTROLLER_STATUS':  /* controllerId, status */ break;
    case 'ALARM_RAISED':       /* alarm */ break;
    case 'DISCONNECTED':       /* reason */ break;
    case 'CONNECTED':          break;
  }
});
```

Notes worth reading before you build against it:

- Events arrive every **2–4 seconds** while connected, in small batches.
- It **drops roughly every 60 seconds** for 5–10 seconds, emitting
  `DISCONNECTED` then `CONNECTED`. No events arrive in between. This is how you
  exercise your reconnect UI — you don't need to unplug your wifi.
- On subscribe you immediately receive the current connection state, so you can
  render the right indicator on mount.
- `eventStream.simulateOutage(7000)` forces a drop on demand while you're
  building. Call it from the console.
- The stream **mutates the same store the REST handlers read from**, so a
  refetch after an event returns consistent data.
- `ZONE_STATE` events fire for zones *you didn't touch* — a scheduled program
  started or finished. Don't assume every state change is the result of your
  own command. This will race with your optimistic updates, which is
  deliberate.

## Latency and failures

| Behaviour | Value |
|---|---|
| Read latency | 200–600 ms |
| Command latency | **1,500–3,000 ms** |
| Read failure | 10% → `500 { code, message }` |
| Command failure | 20% → `409 { code: 'DEVICE_UNREACHABLE', message }` |
| Command to an `OFFLINE` controller | **always** `409` |
| Duplicate program name | `422 { errors: { name: '...' } }` |

The 3-second command with a 20% failure rate is the centre of gravity of this
assignment. It's what makes optimistic updates and rollback necessary rather
than decorative.

## Telemetry

Generated on demand from a per-zone seed rather than stored — 900 zones × 7
days at 1-minute resolution would be ~9 million points. Same zone and same
minute always give the same numbers, so your chart and ours match.

`range=7d` returns **10,080 points (~850 KB)**. That is on purpose. Don't
paginate it away; deal with it on the client and tell us how in `DECISIONS.md`.

The simulation is simple but not wrong: flow ramps in and out rather than
switching square, line pressure *sags* while a valve is open, and soil moisture
climbs during irrigation then decays with a diurnal evapotranspiration wobble.
Zone valve states in `db` are derived from the same schedule the telemetry uses,
so the zones grid and the chart agree — until you start issuing commands, after
which `db` is authoritative for valve state.

## Testing

`src/test/setup.ts` starts an MSW **node** server for Vitest and, by default,
zeroes the latency and failure rates so your suite isn't slow and flaky.

When you want to test a failure path, force it:

```ts
import { configureMocks } from '@/mock';

it('rolls back when the command fails', async () => {
  configureMocks({ commandFailureRate: 1 });   // every command now 409s
  // ...
});
```

`src/mock/__tests__/mock-layer.test.ts` contains smoke tests for this folder.
They're there to prove the harness works — they **don't** count toward the 5–8
tests the assignment asks for. Those should cover your components and hooks.

## Resetting

`db.reset()` restores the seed snapshot. There's also `POST /api/__reset` if you
want a button for it while developing. Reloading the page does the same thing.
