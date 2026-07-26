import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startMocks } from './mock';
import { App } from './App';

async function bootstrap(): Promise<void> {
  // The mock API must be intercepting before the first request goes out.
  await startMocks();

  const container = document.getElementById('root');
  if (!container) throw new Error('#root not found');

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
