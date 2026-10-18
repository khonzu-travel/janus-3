import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PathsData, ProblemData } from '../shared/messages.js';
import { appPageFile, serveAppPage } from './app-pages.js';
import { problemIndexArgument, recentPathArgument, senderAllowed } from './bridge-checks.js';
import { folderArguments } from './command-line.js';
import { menuTemplate, windowTitle, type MenuActions, type MenuState } from './menu.js';
import { openableFile } from './open-file.js';
import { problemView } from './problems.js';
import { startArgs } from './server-args.js';
import { appNavigation, atlasAddress, atlasNavigation, externalDecision, isAppPage } from './urls.js';
import { withWatchDefault } from '../server-host/args.js';

describe('the server start arguments', () => {
  it('sends no flags, or port 0 for Start on a Free Port', () => {
    expect(startArgs(false)).toEqual({ noConfig: false });
    expect(startArgs(true)).toEqual({ noConfig: false, port: 0 });
  });

  it('turns watch on only when the file does not set fixtures.watch', () => {
    expect(withWatchDefault({ noConfig: false }, false)).toEqual({ noConfig: false, watch: true });
    expect(withWatchDefault({ noConfig: false }, true)).toEqual({ noConfig: false });
    expect(withWatchDefault({ noConfig: false, port: 0 }, false)).toEqual({ noConfig: false, port: 0, watch: true });
  });
});

describe("the Atlas window's address", () => {
  it.each([
    ['http://127.0.0.1:4010/_janus/ui/', 'http://127.0.0.1:4010/_janus/ui/'],
    ['http://0.0.0.0:4010/_janus/ui/', 'http://127.0.0.1:4010/_janus/ui/'],
    ['http://[::]:4010/_janus/ui/', 'http://[::1]:4010/_janus/ui/'],
    ['http://[::1]:4010/_janus/ui/', 'http://[::1]:4010/_janus/ui/'],
    ['http://[fe80::1]:4010/_janus/ui/', 'http://[fe80::1]:4010/_janus/ui/'],
    ['http://localhost:4010/_janus/ui/', 'http://localhost:4010/_janus/ui/'],
    ['http://192.168.1.20:80/_janus/ui/', 'http://192.168.1.20/_janus/ui/'],
  ])('loads %s as %s', (bound, expected) => {
    expect(atlasAddress(bound)).toBe(expected);
  });
});

describe('navigation and window opening', () => {
  const ui = 'http://127.0.0.1:4010/_janus/ui/';
  it.each([
    ['http://127.0.0.1:4010/_janus/ui/', 'allow'],
    ['http://127.0.0.1:4010/_janus/ui/#/endpoints', 'allow'],
    ['http://127.0.0.1:4010/_janus/ui/assets/x.js?y=1', 'allow'],
    ['http://127.0.0.1:4010/hello', 'external'],
    ['http://127.0.0.1:4010/_janus/health', 'external'],
    ['http://127.0.0.1:4010/_janus/uix', 'external'],
    ['http://127.0.0.1:4011/_janus/ui/', 'external'],
    ['http://localhost:4010/_janus/ui/', 'external'],
    ['https://example.com/', 'external'],
    ['file:///etc/passwd', 'drop'],
    ['javascript:alert(1)', 'drop'],
    ['janus-app://app/start.html', 'drop'],
    ['mailto:a@example.com', 'drop'],
    ['data:text/html,hi', 'drop'],
    ['not a url', 'drop'],
  ])('an Atlas window going to %s: %s', (url, decision) => {
    expect(atlasNavigation(url, ui)).toBe(decision);
  });

  it('opens only http and https in the system browser', () => {
    expect(externalDecision('http://example.com')).toBe('external');
    expect(externalDecision('https://example.com')).toBe('external');
    for (const url of ['file:///x', 'ftp://x', 'smb://host/share', 'vscode://x', 'janus-app://app/', '']) {
      expect(externalDecision(url)).toBe('drop');
    }
  });

  it("keeps the app's own pages on janus-app://app/", () => {
    expect(appNavigation('janus-app://app/status.html')).toBe('allow');
    expect(appNavigation('janus-app://other/status.html')).toBe('drop');
    expect(appNavigation('https://example.com')).toBe('external');
    expect(isAppPage('janus-app://app/')).toBe(true);
    expect(isAppPage('http://app/')).toBe(false);
  });
});

describe('the bridge', () => {
  it('accepts only frames of app views showing janus-app://app/', () => {
    expect(senderAllowed('janus-app://app/start.html', true)).toBe(true);
    expect(senderAllowed('janus-app://app/start.html', false)).toBe(false);
    expect(senderAllowed('http://127.0.0.1:4010/_janus/ui/', true)).toBe(false);
    expect(senderAllowed(undefined, true)).toBe(false);
  });

  it('accepts only recent paths and problem indexes', () => {
    expect(recentPathArgument('/a', ['/a', '/b'])).toBe('/a');
    expect(recentPathArgument('/c', ['/a'])).toBeNull();
    expect(recentPathArgument(['/a'], ['/a'])).toBeNull();
    expect(problemIndexArgument(0, 2)).toBe(0);
    expect(problemIndexArgument(2, 2)).toBeNull();
    expect(problemIndexArgument(-1, 2)).toBeNull();
    expect(problemIndexArgument(0.5, 2)).toBeNull();
    expect(problemIndexArgument('0', 2)).toBeNull();
  });
});

describe('the command line', () => {
  it('finds folder arguments, skipping switches and the app path from source', () => {
    expect(folderArguments(['/opt/janus-desktop', './shop', '--flag'], false, '/work')).toEqual(['/work/shop']);
    expect(folderArguments(['electron', '--inspect=0', '.', '/abs'], true, '/work')).toEqual(['/abs']);
    expect(folderArguments(['electron', '.'], true, '/work')).toEqual([]);
  });
});

describe('Open File containment', () => {
  let root: string;
  let outside: string;
  let paths: PathsData;
  const fixture = (path: string): ProblemData => ({ code: 'x', source: 'fixtures', path, message: 'm' });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'janus-open-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'janus-outside-')));
    await mkdir(join(root, 'data', 'default'), { recursive: true });
    await writeFile(join(root, 'data', 'default', 'a.json'), '{}');
    await writeFile(join(root, 'janus.config.yaml'), '');
    await writeFile(join(outside, 'secret.json'), '{}');
    paths = {
      cwd: root,
      configFile: join(root, 'janus.config.yaml'),
      fixturesRoot: join(root, 'data'),
      captures: null,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('opens fixture and configuration files inside the project', async () => {
    expect(await openableFile(fixture('default/a.json'), paths)).toBe(join(root, 'data', 'default', 'a.json'));
    expect(await openableFile({ code: 'x', source: 'config', path: 'janus.config.yaml', message: 'm' }, paths)).toBe(
      join(root, 'janus.config.yaml'),
    );
  });

  it('refuses .. and symbolic links out of the project', async () => {
    expect(await openableFile(fixture(`../../${outside.split('/').pop() ?? ''}/secret.json`), paths)).toBeNull();
    await symlink(join(outside, 'secret.json'), join(root, 'data', 'default', 'link.json'));
    expect(await openableFile(fixture('default/link.json'), paths)).toBeNull();
  });

  it('allows a fixture root outside the project folder when configured', async () => {
    const external = { ...paths, fixturesRoot: outside };
    expect(await openableFile(fixture('secret.json'), external)).toBe(join(outside, 'secret.json'));
  });

  it('has nothing to open for missing files and command-line problems', async () => {
    expect(await openableFile(fixture('default/none.json'), paths)).toBeNull();
    expect(await openableFile({ code: 'x', source: 'cli', path: '--port', message: 'm' }, paths)).toBeNull();
  });

  it('words problems as the CLI does', () => {
    const view = problemView(
      {
        code: 'invalid-json',
        source: 'fixtures',
        path: 'default/a.json',
        line: 3,
        column: 7,
        message: 'bad',
        token: 'x',
      },
      'error',
      paths,
      true,
    );
    expect(view).toEqual({
      severity: 'error',
      code: 'invalid-json',
      location: 'data/default/a.json:3:7',
      message: 'bad',
      token: 'x',
      canOpen: true,
    });
  });
});

describe("the app's own pages", () => {
  let pages: string;
  beforeEach(async () => {
    pages = await mkdtemp(join(tmpdir(), 'janus-pages-'));
    await writeFile(join(pages, 'start.html'), '<!doctype html>');
  });
  afterEach(async () => {
    await rm(pages, { recursive: true, force: true });
  });

  it('serves bundled files with the CSP', async () => {
    const response = await serveAppPage('janus-app://app/start.html', pages);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it.each([
    'janus-app://app/missing.html',
    'janus-app://app/',
    'janus-app://other/start.html',
    'janus-app://app/%2e%2e/%2e%2e/etc/passwd.html',
    'janus-app://app/start.exe',
  ])('answers %s with a 404', async (url) => {
    expect((await serveAppPage(url, pages)).status).toBe(404);
  });

  it('never resolves outside the pages', () => {
    // The URL parser already folds dot segments into the path, so they stay inside the pages.
    expect(appPageFile('janus-app://app/a/../../x.html', pages)).toBe(join(pages, 'x.html'));
    expect(appPageFile('janus-app://app/%2e%2e%2fx.html', pages)).toBe(join(pages, 'x.html'));
    expect(appPageFile('janus-app://app/assets/x.js', pages)).toBe(join(pages, 'assets', 'x.js'));
  });
});

describe('menus and the window title', () => {
  const actions = new Proxy({}, { get: () => () => undefined }) as MenuActions;
  const server = (state: MenuState): Record<string, boolean | undefined> => {
    const menu = menuTemplate(state, actions).find((item) => item.label === 'Server');
    const items = (menu?.submenu ?? []) as { label?: string; enabled?: boolean }[];
    return Object.fromEntries(
      items.flatMap((item) => (item.label === undefined ? [] : [[item.label, item.enabled] as const])),
    );
  };
  const base: MenuState = { platform: 'linux', development: false, project: null, recent: [] };

  it('disables server items without a project', () => {
    expect(Object.values(server(base)).every((enabled) => enabled === false)).toBe(true);
  });

  it('enables items that need a running server only while it runs', () => {
    const stopped = server({ ...base, project: { running: false, recording: false } });
    expect(stopped).toMatchObject({
      Restart: true,
      'Reload Fixtures': false,
      'Configuration…': false,
      'Copy Mock URL': false,
      'Show Server Log': true,
    });
    const running = server({ ...base, project: { running: true, recording: false } });
    expect(running).toMatchObject({
      'Reload Fixtures': true,
      'Configuration…': true,
      'Copy Mock URL': true,
      'Show Captures Folder': false,
    });
    expect(server({ ...base, project: { running: true, recording: true } })['Show Captures Folder']).toBe(true);
  });

  it('offers developer tools only in development builds', () => {
    const view = (development: boolean) =>
      JSON.stringify(menuTemplate({ ...base, development }, actions).find((item) => item.label === 'View'));
    expect(view(true)).toContain('Toggle Developer Tools');
    expect(view(false)).not.toContain('Toggle Developer Tools');
  });

  it('titles windows with the project and its state', () => {
    expect(windowTitle('shop-mocks', 'http://127.0.0.1:4010')).toBe('Janus — shop-mocks — http://127.0.0.1:4010');
  });
});
