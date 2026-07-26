import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { server } from '../mock/server';
import { configureMocks, resetMockConfig } from '../mock/handlers';
import { db } from '../mock/db';

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

beforeAll(() => {
  // Random failures and 3-second commands make a suite slow and flaky, so
  // tests run against a deterministic, fast mock by default.
  //
  // To test a failure path, force it inside that test:
  //   configureMocks({ commandFailureRate: 1 });
  configureMocks({
    readLatencyMs: [0, 0],
    commandLatencyMs: [0, 0],
    readFailureRate: 0,
    commandFailureRate: 0,
  });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  db.reset();
  resetMockConfig();
  configureMocks({
    readLatencyMs: [0, 0],
    commandLatencyMs: [0, 0],
    readFailureRate: 0,
    commandFailureRate: 0,
  });
});

afterAll(() => {
  server.close();
});
