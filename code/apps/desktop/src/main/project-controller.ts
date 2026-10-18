import { BaseWindow, WebContentsView, type NativeImage, type Rectangle, type WebContents } from 'electron';

import { CHANNELS, type LogLine, type ProblemView, type ProjectState } from '../shared/bridge.js';
import type { PathsData, ProblemData, StartArgs } from '../shared/messages.js';
import { APP_PAGES } from './app-pages.js';
import { ServerLifecycle, type Phase, type SpawnServer } from './lifecycle.js';
import { LogBook } from './logs.js';
import { windowTitle } from './menu.js';
import { openableFile } from './open-file.js';
import { problemView } from './problems.js';
import type { Project } from './projects.js';
import { startArgs } from './server-args.js';
import { atlasAddress } from './urls.js';

/** Lines shown when a server stops on its own. */
const EXITED_LINES = 50;

export interface ControllerContext {
  readonly spawn: SpawnServer;
  readonly logsDirectory: string;
  readonly preload: string;
  readonly icon: NativeImage;
  readonly atlasPartition: string;
  readonly bounds: Partial<Rectangle> & { width: number; height: number };
  readonly minimum: { readonly width: number; readonly height: number };
  /** Registers a view so navigation and bridge rules know what it is. */
  readonly register: (contents: WebContents, kind: 'status' | 'atlas', controller: ProjectController) => void;
  readonly appLog: (line: string) => void;
  readonly changed: () => void;
  readonly closed: (controller: ProjectController) => void;
}

interface Problem {
  readonly data: ProblemData;
  readonly view: ProblemView;
  readonly file: string | null;
}

/** One project: its window, its views, its server and its log. */
export class ProjectController {
  readonly window: BaseWindow;
  readonly log: LogBook;
  readonly lifecycle: ServerLifecycle;
  private readonly statusView: WebContentsView;
  private atlasView: WebContentsView | null = null;
  private atlasUrl: string | null = null;
  private problems: readonly Problem[] = [];
  private lastArgs: StartArgs = startArgs(false);
  private state: ProjectState;
  /** The last paths the server reported, for Show Data Folder and Open File. */
  paths: PathsData | null = null;
  mockUrl: string | null = null;
  logWindow: { focus(): void; close(): void; isDestroyed(): boolean } | null = null;

  constructor(
    readonly project: Project,
    private readonly context: ControllerContext,
  ) {
    this.state = { kind: 'starting', name: project.name, folder: project.path };
    this.log = new LogBook(context.logsDirectory, project.id);
    this.window = new BaseWindow({
      ...context.bounds,
      minWidth: context.minimum.width,
      minHeight: context.minimum.height,
      title: windowTitle(project.name, 'starting'),
      icon: context.icon,
      show: false,
    });
    if (process.platform === 'darwin') this.window.setRepresentedFilename(project.path);
    this.statusView = new WebContentsView({ webPreferences: appPreferences(context.preload) });
    context.register(this.statusView.webContents, 'status', this);
    this.show(this.statusView);
    void this.statusView.webContents.loadURL(APP_PAGES.status);
    this.window.on('resize', () => {
      this.layout();
    });
    this.window.on('closed', () => {
      this.dropAtlas();
      this.statusView.webContents.close();
      context.closed(this);
    });
    this.window.show();

    this.lifecycle = new ServerLifecycle(project.path, context.spawn, {
      change: (phase) => {
        void this.update(phase);
      },
      log: (line) => {
        this.log.append(line);
      },
      ignored: () => {
        context.appLog(`server-message-ignored project=${project.id}`);
      },
      run: () => {
        this.log.rotate();
      },
    });
  }

  get projectState(): ProjectState {
    return this.state;
  }

  get running(): boolean {
    return this.lifecycle.phase.kind === 'running';
  }

  /** Starts the server; `freePort` runs it on port 0 for this run only. */
  start(freePort = false): Promise<void> {
    this.lastArgs = startArgs(freePort);
    return this.lifecycle.start(this.lastArgs);
  }

  /** Retry: a new process with the same arguments. */
  retry(): Promise<void> {
    return this.lifecycle.start(this.lastArgs);
  }

  focus(): void {
    if (this.window.isMinimized()) this.window.restore();
    this.window.focus();
  }

  /** `<origin>/_janus/ui/` of the Atlas view, the only place it may navigate. */
  get atlasBase(): string | null {
    return this.atlasUrl === null ? null : `${new URL(this.atlasUrl).origin}/_janus/ui/`;
  }

  /** Opens the Atlas window's Requests page with the import dialog. */
  openImport(): void {
    const base = this.atlasBase;
    if (this.atlasView === null || base === null) return;
    this.focus();
    void this.atlasView.webContents.loadURL(`${base}#/requests?import=1`).catch((error: unknown) => {
      this.context.appLog(`atlas-load-failed project=${this.project.id} reason=${JSON.stringify(String(error))}`);
    });
  }

  /**
   * Opens the Configuration dialog over the Atlas window's current view: only
   * the address's fragment changes, so the page is not reloaded.
   */
  openConfiguration(): void {
    const base = this.atlasBase;
    if (this.atlasView === null || base === null) return;
    this.focus();
    const current = this.atlasView.webContents.getURL();
    const hash = current.startsWith(base) ? new URL(current).hash.slice(1) : '';
    const at = hash.indexOf('?');
    const path = (at === -1 ? hash : hash.slice(0, at)) || '/';
    const query = new URLSearchParams(at === -1 ? '' : hash.slice(at + 1));
    query.set('config', '1');
    void this.atlasView.webContents.loadURL(`${base}#${path}?${query.toString()}`).catch((error: unknown) => {
      this.context.appLog(`atlas-load-failed project=${this.project.id} reason=${JSON.stringify(String(error))}`);
    });
  }

  /** The visible page, for Reload Page, zoom and developer tools. */
  get visibleContents(): WebContents {
    return (this.atlasView ?? this.statusView).webContents;
  }

  problemFile(index: number): string | null {
    return this.problems[index]?.file ?? null;
  }

  appendLog(line: LogLine): void {
    this.log.append(line);
  }

  private async update(phase: Phase): Promise<void> {
    const base = { name: this.project.name, folder: this.project.path };
    let title: string;
    switch (phase.kind) {
      case 'starting':
        this.dropAtlas();
        this.problems = [];
        this.mockUrl = null;
        this.state = { ...base, kind: 'starting' };
        title = 'starting';
        break;
      case 'running': {
        const { result } = phase;
        this.paths = result.paths;
        this.mockUrl = result.url;
        title = result.url;
        const missing = result.warnings.some((warning) => warning.code === 'ui-assets-missing');
        this.state = {
          ...base,
          kind: 'running',
          mockUrl: result.url,
          withoutUi: result.uiUrl !== null ? null : missing ? 'not-built' : 'disabled',
        };
        if (result.uiUrl !== null) this.showAtlas(atlasAddress(result.uiUrl));
        break;
      }
      case 'invalid': {
        const { result } = phase;
        this.paths = result.paths;
        const problems: Problem[] = [];
        for (const [severity, list] of [
          ['error', result.errors],
          ['warning', result.warnings],
        ] as const) {
          for (const data of list) {
            const file = await openableFile(data, result.paths);
            problems.push({ data, file, view: problemView(data, severity, result.paths, file !== null) });
          }
        }
        // A newer phase may have arrived while files were checked.
        if (this.lifecycle.phase !== phase) return;
        this.problems = problems;
        this.state = {
          ...base,
          kind: 'invalid',
          problems: problems.map((problem) => problem.view),
          notes: result.notes,
        };
        title = 'needs attention';
        break;
      }
      case 'bind-failed': {
        const { result } = phase;
        this.paths = result.paths;
        this.state =
          result.code === 'EADDRINUSE'
            ? { ...base, kind: 'port-in-use', host: result.host, port: result.port }
            : { ...base, kind: 'bind-failed', host: result.host, port: result.port, code: result.code };
        title = 'needs attention';
        break;
      }
      case 'stopping':
        this.mockUrl = null;
        this.state = { ...base, kind: 'stopping' };
        title = 'stopped';
        break;
      case 'stopped':
        this.dropAtlas();
        this.mockUrl = null;
        this.state = { ...base, kind: 'stopping' };
        title = 'stopped';
        break;
      case 'exited':
        this.dropAtlas();
        this.mockUrl = null;
        this.state = { ...base, kind: 'exited', exitCode: phase.code, lastLines: this.log.tail(EXITED_LINES) };
        title = 'stopped';
        break;
    }
    if (this.window.isDestroyed()) return;
    this.window.setTitle(windowTitle(this.project.name, title));
    if (this.atlasView === null) this.show(this.statusView);
    if (!this.statusView.webContents.isDestroyed()) {
      this.statusView.webContents.send(CHANNELS.projectStateChanged, this.state);
    }
    this.context.changed();
  }

  private showAtlas(url: string): void {
    if (this.atlasView !== null && this.atlasUrl === url) return;
    this.dropAtlas();
    const view = new WebContentsView({ webPreferences: atlasPreferences(this.context.atlasPartition) });
    this.atlasView = view;
    this.atlasUrl = url;
    this.context.register(view.webContents, 'atlas', this);
    this.show(view);
    void view.webContents.loadURL(url).catch((error: unknown) => {
      this.context.appLog(`atlas-load-failed project=${this.project.id} reason=${JSON.stringify(String(error))}`);
    });
  }

  private dropAtlas(): void {
    const view = this.atlasView;
    if (view === null) return;
    this.atlasView = null;
    this.atlasUrl = null;
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
    view.webContents.close();
  }

  private show(view: WebContentsView): void {
    if (this.window.isDestroyed()) return;
    for (const child of this.window.contentView.children) {
      if (child !== view) this.window.contentView.removeChildView(child);
    }
    if (!this.window.contentView.children.includes(view)) this.window.contentView.addChildView(view);
    this.layout();
  }

  private layout(): void {
    const { width, height } = this.window.getContentBounds();
    for (const child of this.window.contentView.children) child.setBounds({ x: 0, y: 0, width, height });
  }
}

/** Every window's hardening, plus the bridge for the app's own pages. */
export function appPreferences(preload: string): Electron.WebPreferences {
  return { ...hardened(), preload };
}

/** Atlas views: no preload, one persistent partition. */
export function atlasPreferences(partition: string): Electron.WebPreferences {
  return { ...hardened(), partition };
}

function hardened(): Electron.WebPreferences {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
  };
}
