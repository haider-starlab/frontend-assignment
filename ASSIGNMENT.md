# Frontend Intern Assignment — "FieldOps Console"

**Role:** Frontend Engineering Intern (ReactJS)
**Timebox:** 1–2 days (we expect ~6–10 hours of actual work — please do not exceed this)
**Submission:** Git repository (GitHub/GitLab) + short write-up

---

## 1. Context

We build wireless irrigation and water-management automation. Our platform pairs Motorola field hardware (MC Edge gateways, ACE3600 RTUs, RIO XT/R remote I/O nodes) with a cloud application that growers use to control pumps, valves, reservoirs and fertigation across thousands of acres — often from a phone, in a field, on a bad connection.

You are going to build a small slice of that world: **FieldOps Console**, an operator-facing dashboard for monitoring and controlling irrigation at a set of farm sites.

This is a realistic industrial-control UI problem. That means three things matter more than usual:

1. **Truthfulness of state** — an operator must never be shown a valve as "closed" when it isn't.
2. **Live data** — telemetry and alarms arrive continuously; the UI must stay responsive.
3. **Failure is normal** — radios drop, RTUs go offline, commands time out. Your UI must handle it gracefully, not crash or silently swallow it.

You do **not** need to build a backend. A mock API + event stream is specified in Section 5.

---

## 2. Tech constraints

**Required**
- React 18+ with **function components and hooks**
- **TypeScript** (strict mode on)
- Vite (SSR is not required or evaluated)
- Client-side routing with deep-linkable URLs
- Your own CSS approach: CSS Modules, Tailwind, vanilla-extract, styled-components — your call

**Allowed and encouraged**
- Data-fetching / server-state library (TanStack Query, SWR, RTK Query)
- Client-state library if you need one (Zustand, Redux Toolkit, Jotai, or plain Context + reducer)
- A light-weight component library for primitives (Radix, shadcn/ui, MUI, Mantine)

**Not allowed**
- A no-code/low-code UI builder or a cloned open-source dashboard template as the base
- Committing a `dist/` build or `node_modules`

Every library choice must be justified in one line in `DECISIONS.md`. We care much more about *why* than *which*.

---

## 3. What to build

Two routes. Build both — breadth is part of what's being tested.

### 3.1 `/` — Operations Overview

The screen an operator leaves open on a wall monitor.

- **KPI tiles:** sites online, controllers online/total, zones currently irrigating, total flow (GPM) right now, open critical alarms, water used today (gallons).
- **Live alarm feed:** newest first, severity-coded, auto-updating from the event stream. Must be announced to screen readers politely (`aria-live`), not aggressively.
- **"Currently irrigating" strip:** every zone in `IRRIGATING` state with its site, elapsed runtime, and live flow rate. Runtime should tick without a full-page refetch.
- Empty states and skeleton loading states are required, not optional.
- Clicking a site name in the irrigating strip or alarm feed should navigate to that site's detail page.

### 3.2 `/sites/:siteId` — Site Detail (Zones only)

A single site's control surface.

- Display the site name and a small summary (region, acres, online controller count).
- **Zones grid or list:** name, crop, valve state, flow GPM, pressure PSI, soil moisture %, controlling device.
- **Start / Stop irrigation** per zone:
  - The command endpoint is slow (1.5–3 s) and fails sometimes (see 5.3).
  - Use an **optimistic update** with a clear pending state, and **roll back with a visible error** on failure.
  - A zone whose controller is `OFFLINE` cannot be commanded — disable it and explain why in an accessible way (not just a greyed-out button).
  - Starting a zone must open a confirmation dialog that shows estimated water volume. The dialog must trap focus, close on `Esc`, and return focus to the trigger.
  - Double-clicking Start must not send two commands.
- Live updates from the event stream must update zone telemetry and valve state without a full refetch.
- Empty states and skeleton loading states are required, not optional.

---

## 4. Cross-cutting requirements

| Area | Requirement |
|---|---|
| **Real-time** | Consume the mock event stream. Telemetry ticks and new alarms must update the UI without a full refetch and without re-rendering unrelated subtrees. |
| **Errors** | Every async surface has a loading, empty, and error state with a retry path. One top-level error boundary minimum. Never a blank screen. |
| **Offline / stale** | If the stream disconnects, show a "reconnecting" indicator and mark live values as stale. Reconnect with backoff. |
| **Performance** | No jank on the zones grid. Be able to explain — with numbers or a profiler screenshot — one thing you measured and improved. |
| **Accessibility** | Keyboard operable end to end, visible focus, dialogs trap focus, colour is never the only carrier of meaning (severity, valve state), passes an axe scan with no serious violations. |
| **Responsive** | Works at 375px, 768px and 1440px. The zones grid must remain usable on a phone. |
| **Testing** | 3–5 meaningful tests (React Testing Library / Vitest). We'd rather see one good test of optimistic rollback than twenty snapshot tests. At least one test must cover a failure path. |

---

## 5. Explicitly out of scope

Don't spend time on: the `/sites` list table, telemetry charts, the alarms tab, the irrigation program builder, authentication, a real backend or database, a map view, i18n, dark mode, CI pipelines, Docker, e2e tests, or pixel-matching a design. None of these earn points.

---

## 6. Mock API & data contract

Implement the mock layer **exactly as specified** so we can compare submissions fairly. Use MSW (recommended), or a plain async module — either is fine.

### 6.1 Types

```ts
type ControllerType = 'MC_EDGE' | 'ACE3600' | 'RIO_XTR';
type DeviceStatus   = 'ONLINE' | 'DEGRADED' | 'OFFLINE';
type ValveState     = 'IRRIGATING' | 'IDLE' | 'FAULT';
type Severity       = 'CRITICAL' | 'WARNING' | 'INFO';

interface Site {
  id: string; name: string; region: string;
  acres: number; timezone: string;          // IANA, e.g. 'America/Los_Angeles'
  coordinates: { lat: number; lng: number };
}

interface Controller {
  id: string; siteId: string; name: string;
  type: ControllerType; status: DeviceStatus;
  firmware: string;
  batteryVolts: number | null;              // null for mains-powered
  rssiDbm: number | null;                   // signal strength
  lastSeenAt: string;                       // ISO 8601
}

interface Zone {
  id: string; siteId: string; controllerId: string;
  name: string; crop: string; areaAcres: number;
  valveState: ValveState;
  nominalFlowGpm: number;
  flowGpm: number; pressurePsi: number; soilMoisturePct: number;
  irrigationStartedAt: string | null;
}

interface Alarm {
  id: string; siteId: string;
  controllerId: string | null; zoneId: string | null;
  severity: Severity;
  type: 'LOW_PRESSURE' | 'HIGH_PRESSURE' | 'COMM_LOSS'
      | 'LEAK_SUSPECTED' | 'PUMP_FAULT' | 'BATTERY_LOW' | 'FLOW_ANOMALY';
  message: string;
  raisedAt: string; acknowledgedAt: string | null; acknowledgedBy: string | null;
}
```

### 6.2 Endpoints you will use

```
GET   /api/summary
GET   /api/alarms                    ?limit &severity[] &acknowledged
GET   /api/sites/:id
GET   /api/sites/:id/controllers
GET   /api/sites/:id/zones
POST  /api/zones/:id/command         { action: 'START' | 'STOP' }
```

`/api/sites/:id` returns a `SiteListRow` — the `Site` fields plus derived roll-ups (`controllerCounts`, `onlinePct`, `openAlarms`, `zoneCount`, `irrigatingZoneCount`, `lastCommsAt`). You don't need to compute those yourself.

### 6.3 Required mock behaviour

- **Latency:** reads 200–600 ms (random). `POST /api/zones/:id/command` 1,500–3,000 ms.
- **Read failures:** 10% of read requests return `500`.
- **Command failures:** 20% of commands return `409 { code: 'DEVICE_UNREACHABLE', message: ... }`. Commands to a zone on an `OFFLINE` controller always return `409`.
- **Seed volume:** 40 sites (≥ 4 distinct regions, ≥ 3 distinct timezones), 600 controllers, 900 zones, 250 alarms. Generate deterministically from a fixed seed so runs are reproducible.
- **Event stream:** a module exposing `subscribe(handler): () => void`, emitting every 2–4 s:
  - `{ type: 'TELEMETRY', zoneId, flowGpm, pressurePsi, soilMoisturePct, t }`
  - `{ type: 'ALARM_RAISED', alarm }`
  - `{ type: 'ZONE_STATE', zoneId, valveState }`
  - `{ type: 'CONTROLLER_STATUS', controllerId, status }`
  - It must also **simulate a disconnect** roughly every 60 s, staying down 5–10 s, so your reconnect UI is exercisable.

You may implement the stream over `setInterval`, a `BroadcastChannel`, or a real local WebSocket. Say which and why.

---

## 7. Deliverables

1. **Repository** with a clean, readable commit history (not one "initial commit"). Conventional commit messages are welcome but not required.
2. **`README.md`** — how to run it (`npm i && npm run dev` must be enough), what's done, what isn't, known bugs. Honesty here scores well; overclaiming does not.
3. **`DECISIONS.md`** — max 1 page:
   - Architecture: how you organised state, and where server state ends and client state begins.
   - One-line justification per non-trivial dependency.
   - How you handled optimistic updates and rollback.
   - What you measured for performance and what changed.
   - What you'd do with another day, and what you knowingly cut.
4. **Optional (strongly liked):** a 2–3 minute screen recording walking through the app and one piece of code you're proud of.

---

## 8. Ground rules

- **AI assistance is allowed.** Copilot, Claude, Cursor — use them. But you must be able to explain and defend every line in a follow-up call, and we will ask you to modify your own code live. Code you can't explain is worse than code you didn't write.
- **Don't gold-plate.** A polished 90% is better than a broken 110%. If you cut something, write it in the README.
- **Ask questions.** If a requirement is ambiguous, either email us or make a reasonable assumption and document it in `DECISIONS.md`. Documenting assumptions scores points; guessing silently doesn't.
- **Your code stays yours.** We use it only for evaluation and delete it afterwards; nothing here ships to production.

Good luck — we're looking forward to seeing how you think.
