import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  protocol,
  screen,
  session,
  shell,
  utilityProcess,
  webContents as allWebContents,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from 'electron';
import { ipcMain } from 'electron';

import { APP_SCHEME, CHANNELS, type LogLine } from '../shared/bridge.js';
import { APP_PAGES, serveAppPage } from './app-pages.js';
import { problemIndexArgument, recentPathArgument, senderAllowed } from './bridge-checks.js';
import { folderArguments } from './command-line.js';
import { createProject } from './create-project.js';
import type { SpawnServer } from './lifecycle.js';
import { stopAll, type ServerLifecycle } from './lifecycle.js';
import { LogBook } from './logs.js';
import { menuTemplate } from './menu.js';
import { ProjectController, appPreferences } from './project-controller.js';
import { detectProject, lastProject, type Project } from './projects.js';
import { RecentProjects } from './recent.js';
import { appNavigation, atlasAddress, atlasNavigation, externalDecision } from './urls.js';
import { clampBounds, DEFAULT_SIZE, MIN_SIZE, WindowStates } from './window-state.js';

// The Electron main process: projects, windows, menus, the
// bridge, server processes, recent projects and the logs. It never reads
// fixtures or configuration; each project's server process does.

const here = dirname(fileURLToPath(import.meta.url));
const PAGES_ROOT = join(here, '..', 'pages');
const PRELOAD = join(here, '..', 'preload', 'index.cjs');
const SERVER_HOST = join(here, '..', 'server-host', 'index.js');
// The app icon, for windows and the taskbar or Dock when run from source (an installer embeds it as well).
const ICON = join(here, '..', '..', 'build', 'icon.png');
const APP_ID = 'io.github.khonzu-travel.janus';
const ATLAS_PARTITION = 'persist:atlas';
const VERSION = (JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version: string })
  .version;
const TESTING = process.env['JANUS_DESKTOP_TEST'] === '1';

const userData = process.env['JANUS_DESKTOP_USER_DATA'];
if (userData !== undefined && userData !== '') app.setPath('userData', userData);
app.setName('Janus');

// Registered before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void run();
}

type ViewKind = 'start' | 'status' | 'log' | 'atlas';

interface ViewInfo {
  readonly kind: ViewKind;
  readonly controller: ProjectController | null;
}

async function run(): Promise<void> {
  const pending: string[] = folderArguments(process.argv, process.defaultApp, process.cwd());
  let ready = false;
  // macOS: a folder dropped on the Dock icon, possibly before the app is ready.
  app.on('open-file', (event, path) => {
    event.preventDefault();
    if (ready) void openFolder(path);
    else pending.push(path);
  });

  await app.whenReady();
  const icon = nativeImage.createFromPath(ICON);
  // Windows groups the taskbar button by app ID; without one the window takes electron.exe's icon.
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  if (process.platform === 'darwin' && !icon.isEmpty()) app.dock?.setIcon(icon);
  const dataDirectory = app.getPath('userData');
  const logsDirectory = join(dataDirectory, 'logs');
  const appLogBook = new LogBook(logsDirectory, 'app');
  appLogBook.rotate();
  const appLog = (line: string): void => {
    appLogBook.append({ stream: 'out', line: `${new Date().toISOString()} ${line}` });
  };
  appLog(`app-started version=${VERSION} electron=${process.versions.electron}`);

  const recent = await RecentProjects.load(join(dataDirectory, 'recent-projects.json'), appLog);
  const windowStates = await WindowStates.load(join(dataDirectory, 'window-state.json'), appLog);

  const views = new Map<number, ViewInfo>();
  const controllers = new Map<string, ProjectController>();
  /** Servers of closed windows still finishing their shutdown. */
  const closing = new Set<ServerLifecycle>();
  let startWindow: BrowserWindow | null = null;

  // ---- Sessions and security ----

  const hardenSession = (target: Session): void => {
    target.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    target.setPermissionCheckHandler(() => false);
    target.on('will-download', (event) => {
      event.preventDefault();
    });
  };
  hardenSession(session.defaultSession);
  hardenSession(session.fromPartition(ATLAS_PARTITION));
  app.on('session-created', hardenSession);

  session.defaultSession.protocol.handle(APP_SCHEME, (request) => serveAppPage(request.url, PAGES_ROOT));

  const openExternal = (url: string): void => {
    if (externalDecision(url) === 'external') void shell.openExternal(url);
    else appLog(`external-url-dropped url=${JSON.stringify(url.slice(0, 200))}`);
  };

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      appLog('webview-refused');
    });
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
    const guard = (event: Electron.Event, url: string): void => {
      const info = views.get(contents.id);
      const decision =
        info?.kind === 'atlas' ? atlasNavigation(url, info.controller?.atlasBase ?? '') : appNavigation(url);
      if (decision === 'allow') return;
      event.preventDefault();
      if (decision === 'external') openExternal(url);
      else appLog(`navigation-dropped url=${JSON.stringify(url.slice(0, 200))}`);
    };
    contents.on('will-navigate', guard);
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame) guard(event, event.url);
    });
    contents.on('will-redirect', (event) => {
      guard(event, event.url);
    });
    contents.on('destroyed', () => views.delete(contents.id));
  });

  // ---- Server processes ----

  const uiRoot = app.isPackaged ? join(process.resourcesPath, 'ui') : resolveUiRoot();
  const spawn: SpawnServer = (cwd, events) => {
    const child = utilityProcess.fork(SERVER_HOST, [], {
      cwd,
      serviceName: 'Janus server',
      stdio: 'pipe',
      env: { ...process.env, ...(uiRoot === null ? {} : { JANUS_DESKTOP_UI_ROOT: uiRoot }) },
    });
    const relay = (stream: NodeJS.ReadableStream | null): void => {
      stream?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n'))
          if (line !== '') events.message({ type: 'log', stream: 'err', line });
      });
    };
    relay(child.stdout);
    relay(child.stderr);
    child.on('message', (data: unknown) => {
      events.message(data);
    });
    child.on('exit', (code) => {
      events.exit(code);
    });
    return {
      postMessage: (message) => {
        child.postMessage(message);
      },
      kill: () => {
        child.kill();
      },
      get pid() {
        return child.pid;
      },
    };
  };

  // ---- Projects ----

  const showStart = (): void => {
    if (startWindow !== null && !startWindow.isDestroyed()) {
      startWindow.show();
      startWindow.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 720,
      height: 560,
      minWidth: 560,
      minHeight: 420,
      title: 'Janus',
      icon,
      show: false,
      webPreferences: appPreferences(PRELOAD),
    });
    startWindow = window;
    views.set(window.webContents.id, { kind: 'start', controller: null });
    window.once('ready-to-show', () => {
      window.show();
    });
    window.on('closed', () => {
      if (startWindow === window) startWindow = null;
    });
    void window.loadURL(APP_PAGES.start);
  };

  const closeStart = (): void => {
    if (startWindow !== null && !startWindow.isDestroyed()) startWindow.close();
  };

  const boundsFor = (project: Project): { x?: number; y?: number; width: number; height: number } => {
    const saved = windowStates.get(project.id);
    const areas = screen.getAllDisplays().map((display) => display.workArea);
    const clamped = saved === undefined ? null : clampBounds(saved, areas);
    return clamped ?? { ...DEFAULT_SIZE };
  };

  const openProject = async (project: Project): Promise<void> => {
    const open = controllers.get(project.id);
    if (open !== undefined) {
      open.focus();
      return;
    }
    const controller = new ProjectController(project, {
      spawn,
      logsDirectory,
      preload: PRELOAD,
      icon,
      atlasPartition: ATLAS_PARTITION,
      bounds: boundsFor(project),
      minimum: MIN_SIZE,
      register: (contents, kind, owner) => {
        views.set(contents.id, { kind, controller: owner });
      },
      appLog,
      changed: () => {
        refreshMenu();
      },
      closed: (owner) => {
        controllers.delete(owner.project.id);
        closing.add(owner.lifecycle);
        void owner.lifecycle.stop().finally(() => closing.delete(owner.lifecycle));
        if (owner.logWindow !== null && !owner.logWindow.isDestroyed()) owner.logWindow.close();
        refreshMenu();
        if (controllers.size === 0 && !quitting) showStart();
      },
    });
    controller.window.on('close', () => {
      void windowStates.save(project.id, controller.window.getNormalBounds());
    });
    controller.window.on('focus', refreshMenu);
    controllers.set(project.id, controller);
    appLog(`project-opened id=${project.id}`);
    closeStart();
    await recent.opened(project.path).catch((error: unknown) => {
      appLog(`recent-projects-write-failed reason=${JSON.stringify(String(error))}`);
    });
    refreshMenu();
    // Saving recents yields: the window may have closed or the app may be quitting meanwhile.
    if (!controller.window.isDestroyed() && !quitting) await controller.start();
  };

  const offerToCreate = async (path: string): Promise<boolean> => {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Create Project', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `“${path}” is not a Janus project.`,
      detail: 'Create a project here? Janus adds janus.config.yaml and a data folder with one example fixture.',
    });
    return response === 0;
  };

  const createAndOpen = async (folder: string): Promise<void> => {
    const created = await createProject(folder);
    if (created.kind === 'failed') {
      appLog(`project-create-failed reason=${JSON.stringify(created.message)}`);
      await dialog.showMessageBox({
        type: 'error',
        message: 'The project could not be created.',
        detail: `${folder}\n\n${created.message}`,
      });
      return;
    }
    const detected = await detectProject(folder);
    if (detected.kind === 'project') await openProject(detected.project);
  };

  async function openFolder(folder: string): Promise<void> {
    const detected = await detectProject(folder);
    switch (detected.kind) {
      case 'project':
        await openProject(detected.project);
        return;
      case 'not-project':
        if (await offerToCreate(detected.path)) await createAndOpen(detected.path);
        return;
      case 'missing':
      case 'unreadable':
        appLog(`project-unavailable kind=${detected.kind}`);
        await dialog.showMessageBox({
          type: 'warning',
          message: detected.kind === 'missing' ? 'The folder no longer exists.' : 'The folder cannot be read.',
          detail: detected.kind === 'missing' ? detected.path : `${detected.path}\n\n${detected.reason}`,
        });
        showStartIfIdle();
        return;
    }
  }

  const showStartIfIdle = (): void => {
    if (controllers.size === 0) showStart();
  };

  const chooseFolder = async (title: string, buttonLabel: string): Promise<string | null> => {
    const parent = BaseWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = {
      title,
      buttonLabel,
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    };
    const result =
      parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };

  const openProjectDialog = async (): Promise<void> => {
    const folder = await chooseFolder('Open Project', 'Open');
    if (folder !== null) await openFolder(folder);
  };

  const newProjectDialog = async (): Promise<void> => {
    const folder = await chooseFolder('New Project', 'Create Project');
    if (folder === null) return;
    const detected = await detectProject(folder);
    if (detected.kind === 'project') await openProject(detected.project);
    else await createAndOpen(folder);
  };

  // ---- The focused project, for the menus ----

  const focusedController = (): ProjectController | null => {
    const focused = BaseWindow.getFocusedWindow();
    if (focused === null) return null;
    for (const controller of controllers.values()) {
      if (controller.window === focused) return controller;
      const log = controller.logWindow as BrowserWindow | null;
      if (log !== null && !log.isDestroyed() && log === focused) return controller;
    }
    return null;
  };

  const focusedContents = (): WebContents | null => {
    const controller = focusedController();
    if (controller !== null && BaseWindow.getFocusedWindow() === controller.window) return controller.visibleContents;
    return BrowserWindow.getFocusedWindow()?.webContents ?? null;
  };

  const showServerLog = (controller: ProjectController): void => {
    const existing = controller.logWindow as BrowserWindow | null;
    if (existing !== null && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 900,
      height: 600,
      title: `Janus — ${controller.project.name} — server log`,
      icon,
      show: false,
      webPreferences: appPreferences(PRELOAD),
    });
    controller.logWindow = window;
    views.set(window.webContents.id, { kind: 'log', controller });
    const unsubscribe = controller.log.subscribe((line: LogLine) => {
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.logLineAdded, line);
    });
    window.once('ready-to-show', () => {
      window.show();
    });
    window.on('page-title-updated', (event) => {
      event.preventDefault();
    });
    window.on('focus', refreshMenu);
    window.on('closed', () => {
      unsubscribe();
      if (controller.logWindow === window) controller.logWindow = null;
    });
    void window.loadURL(APP_PAGES.log);
  };

  const reveal = (path: string | null): void => {
    if (path !== null) shell.showItemInFolder(path);
  };

  let refreshQueued = false;
  function refreshMenu(): void {
    if (refreshQueued) return;
    refreshQueued = true;
    setImmediate(() => {
      refreshQueued = false;
      void buildMenu();
    });
  }

  async function buildMenu(): Promise<void> {
    const controller = focusedController();
    const list = await recent.list();
    const template = menuTemplate(
      {
        platform: process.platform,
        development: !app.isPackaged,
        project:
          controller === null ? null : { running: controller.running, recording: controller.paths?.captures != null },
        recent: list,
      },
      {
        newProject: () => void newProjectDialog(),
        openProject: () => void openProjectDialog(),
        openRecent: (path) => void openFolder(path),
        clearRecent: () => void recent.clear().then(refreshMenu),
        importCollection: () => {
          focusedController()?.openImport();
        },
        openConfiguration: () => {
          focusedController()?.openConfiguration();
        },
        restart: () => {
          const target = focusedController();
          if (target !== null) void target.start(false);
        },
        reloadFixtures: () => {
          const target = focusedController();
          if (target?.mockUrl != null) void reloadFixtures(target.mockUrl);
        },
        copyMockUrl: () => {
          const url = focusedController()?.mockUrl;
          if (url != null) void clipboard.writeText(url);
        },
        openMockUrl: () => {
          const url = focusedController()?.mockUrl;
          if (url != null) openExternal(url);
        },
        showDataFolder: () => {
          const paths = focusedController()?.paths;
          reveal(paths?.fixturesRoot ?? paths?.cwd ?? null);
        },
        showCapturesFolder: () => {
          reveal(focusedController()?.paths?.captures ?? null);
        },
        showServerLog: () => {
          const target = focusedController();
          if (target !== null) showServerLog(target);
        },
        about: () => void showAbout(),
        closeWindow: () => {
          BaseWindow.getFocusedWindow()?.close();
        },
        reloadPage: () => {
          focusedContents()?.reload();
        },
        zoom: (direction) => {
          const contents = focusedContents();
          if (contents === null) return;
          const level = contents.getZoomLevel();
          contents.setZoomLevel(direction === 'reset' ? 0 : direction === 'in' ? level + 0.5 : level - 0.5);
        },
        toggleFullScreen: () => {
          const window = BaseWindow.getFocusedWindow();
          window?.setFullScreen(!window.isFullScreen());
        },
        toggleDevTools: () => {
          focusedContents()?.toggleDevTools();
        },
      },
    );
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  const reloadFixtures = async (url: string): Promise<void> => {
    // Sent from the main process with no Origin, so the origin check allows it.
    try {
      const response = await fetch(new URL('/_janus/reload', atlasAddress(url)), { method: 'POST' });
      appLog(`reload-requested status=${String(response.status)}`);
    } catch (error) {
      appLog(`reload-failed reason=${JSON.stringify(String(error))}`);
    }
  };

  const showAbout = async (): Promise<void> => {
    await dialog.showMessageBox({
      type: 'info',
      title: 'About Janus',
      message: `Janus ${VERSION}`,
      detail: [
        `Electron ${process.versions.electron}`,
        `Chromium ${process.versions.chrome}`,
        `Node ${process.versions.node}`,
      ].join('\n'),
    });
  };

  // ---- The bridge ----

  const handle = (
    channel: string,
    kinds: readonly ViewKind[],
    handler: (info: ViewInfo, event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const info = views.get(event.sender.id);
      const isAppView = info !== undefined && info.kind !== 'atlas' && kinds.includes(info.kind);
      if (!senderAllowed(event.senderFrame?.url, isAppView) || info === undefined) {
        appLog(`bridge-refused channel=${channel}`);
        throw new Error('not allowed');
      }
      return handler(info, event, ...args);
    });
  };
  const project = (info: ViewInfo): ProjectController => {
    if (info.controller === null) throw new Error('not a project window');
    return info.controller;
  };

  handle(CHANNELS.recentProjects, ['start'], () => recent.list());
  handle(CHANNELS.openProject, ['start'], () => openProjectDialog());
  handle(CHANNELS.newProject, ['start'], () => newProjectDialog());
  handle(CHANNELS.openRecent, ['start'], (_info, _event, path) => {
    const valid = recentPathArgument(path, recent.paths());
    if (valid === null) throw new Error('not a recent project');
    return openFolder(valid);
  });
  handle(CHANNELS.removeRecent, ['start'], async (_info, _event, path) => {
    const valid = recentPathArgument(path, recent.paths());
    if (valid === null) throw new Error('not a recent project');
    await recent.remove(valid);
    refreshMenu();
  });
  handle(CHANNELS.projectState, ['status'], (info) => project(info).projectState);
  handle(CHANNELS.retry, ['status'], (info) => project(info).retry());
  handle(CHANNELS.startOnFreePort, ['status'], (info) => project(info).start(true));
  handle(CHANNELS.openProblemFile, ['status'], async (info, _event, index) => {
    const controller = project(info);
    const state = controller.projectState;
    const count = state.kind === 'invalid' ? state.problems.length : 0;
    const valid = problemIndexArgument(index, count);
    const file = valid === null ? null : controller.problemFile(valid);
    if (file === null) throw new Error('no file to open');
    const failure = await shell.openPath(file);
    if (failure !== '') appLog(`open-file-failed reason=${JSON.stringify(failure)}`);
  });
  handle(CHANNELS.copyMockUrl, ['status'], (info) => {
    const url = project(info).mockUrl;
    if (url !== null) void clipboard.writeText(url);
  });
  handle(CHANNELS.showServerLog, ['status'], (info) => {
    showServerLog(project(info));
  });
  handle(CHANNELS.logLines, ['log'], (info) => project(info).log.all());
  handle(CHANNELS.openLogFile, ['log'], async (info) => {
    const failure = await shell.openPath(project(info).log.file);
    if (failure !== '') appLog(`open-log-failed reason=${JSON.stringify(failure)}`);
  });

  // ---- Lifetime ----

  let quitting = false;
  let quit: { now(): void } | null = null;
  let mayQuit = false;
  app.on('before-quit', (event) => {
    if (mayQuit) return;
    quitting = true;
    const alive = [...[...controllers.values()].map((controller) => controller.lifecycle), ...closing].filter(
      (lifecycle) => lifecycle.alive,
    );
    if (alive.length === 0) return;
    event.preventDefault();
    if (quit !== null) {
      appLog('quit-forced');
      quit.now();
      return;
    }
    appLog(`quit-waiting servers=${String(alive.length)}`);
    const stopping = stopAll(alive);
    quit = stopping;
    void stopping.done.then(() => {
      mayQuit = true;
      app.quit();
    });
  });

  // A termination signal (a logout, `kill`) quits the same way, so no server outlives the app.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.quit();
    });
  }

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (controllers.size === 0 && BaseWindow.getAllWindows().length === 0) showStart();
  });

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const folders = folderArguments(argv, process.defaultApp, workingDirectory);
    if (folders.length === 0) {
      const first = controllers.values().next().value;
      if (first !== undefined) first.focus();
      else showStart();
    }
    for (const folder of folders) void openFolder(folder);
  });

  if (TESTING) {
    // Lets the Electron journeys reach the server processes.
    (globalThis as { janusDesktop?: unknown }).janusDesktop = {
      serverPids: () =>
        [...controllers.values()].map((controller) => ({
          project: controller.project.path,
          pid: controller.lifecycle.pid,
        })),
      webContentsIds: () => allWebContents.getAllWebContents().map((contents) => contents.id),
    };
  }

  await buildMenu();
  ready = true;
  if (pending.length === 0) {
    // With no folder argument, reopen the most recent project, or show the start page.
    const last = await lastProject(recent.paths());
    if (last === null) showStart();
    else await openProject(last);
  }
  for (const folder of pending.splice(0)) await openFolder(folder);
}

/** The UI build in a source checkout: `@janus/ui/dist`, as an asset. */
function resolveUiRoot(): string | null {
  try {
    return dirname(fileURLToPath(import.meta.resolve('@janus/ui/dist/index.html')));
  } catch {
    return null;
  }
}
