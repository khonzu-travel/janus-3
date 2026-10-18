// Applies the Atlas theme before the first paint, so the page
// never flashes the wrong theme. Keep in step with src/theme.ts.
/* global window, document */
(function () {
  var choice = 'system';
  try {
    var stored = window.localStorage.getItem('janus-atlas-theme');
    if (stored === 'light' || stored === 'dark') choice = stored;
  } catch {
    // Storage may be unavailable (privacy settings); follow the system.
  }
  var dark =
    choice === 'dark' ||
    (choice === 'system' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
