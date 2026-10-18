import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import { resetStoredFlags } from '../src/features/requests/storedFlag.js';
import { resetTabState } from '../src/features/requests/tabState.js';

afterEach(() => {
  cleanup();
  window.location.hash = '';
  // The Requests tab's per-tab choices (mode, render instant) live in module state.
  resetTabState();
  resetStoredFlags();
});
