import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.js';
import { ConfigErrorPage } from './app/ConfigErrorPage.js';
import { createAtlasClient } from './atlas/client.js';
import { readRuntimeConfig } from './config.js';
import './index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing');

const result = readRuntimeConfig(window.location.href);
createRoot(container).render(
  <StrictMode>
    {result.ok ? (
      <App
        client={createAtlasClient(result.config, {
          onDiagnostic: (entry) => {
            console.warn('janus-atlas request failed', entry);
          },
        })}
      />
    ) : (
      <ConfigErrorPage result={result} />
    )}
  </StrictMode>,
);
