/**
 * Public entry point for the mock layer.
 *
 * Call `startMocks()` once, before rendering. See src/main.tsx.
 */

export { db } from './db';
export {
  handlers,
  MOCK_CONFIG,
  configureMocks,
  resetMockConfig,
  type MockConfig,
  type SiteListRow,
} from './handlers';
export { eventStream, subscribe, createTestStream } from './stream';
export { generateTelemetry, RANGE_MINUTES, isIrrigatingAt } from './telemetry';
export { generateDataset, SEED, TARGET_COUNTS } from './seed';
export * from './types';

export async function startMocks(): Promise<void> {
  const { worker } = await import('./browser');
  await worker.start({
    onUnhandledRequest: 'bypass',
    quiet: false,
  });
  // eslint-disable-next-line no-console
  console.info('[mock] FieldOps mock API ready. Base path: /api');
}
