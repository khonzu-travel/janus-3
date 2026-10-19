import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import { resetStoredFlags } from '../src/features/requests/storedFlag.js';
import { resetTabState } from '../src/features/requests/tabState.js';

// jsdom lays nothing out; CodeMirror measures text ranges, so they report empty boxes.
const emptyRects = (): DOMRectList => Object.assign([], { item: () => null });
Range.prototype.getClientRects = emptyRects;
Range.prototype.getBoundingClientRect = () => new DOMRect();

afterEach(() => {
  cleanup();
  window.location.hash = '';
  // The Requests tab's per-tab choices (mode, render instant) live in module state.
  resetTabState();
  resetStoredFlags();
});
