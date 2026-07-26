/** Node-side MSW server, for Vitest. See src/test/setup.ts. */
import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const server = setupServer(...handlers);
