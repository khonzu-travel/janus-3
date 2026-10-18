// The contract between the app's own pages and the main process.
// Types and constants only, so pages, the preload and the main process can all share it.

export interface RecentProject {
  readonly path: string;
  /** The folder's name. */
  readonly name: string;
  readonly openedAt: string;
  /** The folder no longer exists or cannot be read; shown greyed with Remove. */
  readonly missing: boolean;
}

/** One startup problem, worded as the CLI words it. */
export interface ProblemView {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  /** `<path>[:<line>[:<column>]]`, as the CLI prints it. */
  readonly location: string;
  readonly message: string;
  readonly token?: string;
  /** True when Open File may open it: its file is inside the project, the fixture root or the captures directory. */
  readonly canOpen: boolean;
}

interface ProjectBase {
  readonly name: string;
  readonly folder: string;
}

/** What a project's status page shows. */
export type ProjectState =
  | (ProjectBase & { readonly kind: 'starting' })
  | (ProjectBase & {
      readonly kind: 'invalid';
      readonly problems: readonly ProblemView[];
      readonly notes: readonly string[];
    })
  | (ProjectBase & { readonly kind: 'port-in-use'; readonly host: string; readonly port: number })
  | (ProjectBase & {
      readonly kind: 'bind-failed';
      readonly host: string;
      readonly port: number;
      readonly code: string;
    })
  | (ProjectBase & { readonly kind: 'exited'; readonly exitCode: number; readonly lastLines: readonly string[] })
  | (ProjectBase & {
      readonly kind: 'running';
      readonly mockUrl: string;
      /** Null when the Atlas UI is shown; otherwise why it is not. */
      readonly withoutUi: 'disabled' | 'not-built' | null;
    })
  | (ProjectBase & { readonly kind: 'stopping' });

export interface LogLine {
  readonly stream: 'out' | 'err';
  readonly line: string;
}

export interface JanusAppBridge {
  /** Start page. */
  recentProjects(): Promise<readonly RecentProject[]>;
  /** Folder picker. */
  openProject(): Promise<void>;
  openRecent(path: string): Promise<void>;
  removeRecent(path: string): Promise<void>;
  newProject(): Promise<void>;
  /** Status page; acts on the window's own project. */
  projectState(): Promise<ProjectState>;
  onProjectState(listener: (state: ProjectState) => void): () => void;
  retry(): Promise<void>;
  startOnFreePort(): Promise<void>;
  openProblemFile(index: number): Promise<void>;
  copyMockUrl(): Promise<void>;
  showServerLog(): Promise<void>;
  /** Log page. */
  logLines(): Promise<readonly LogLine[]>;
  onLogLine(listener: (line: LogLine) => void): () => void;
  openLogFile(): Promise<void>;
}

/** The IPC channel behind each bridge method, plus the two events. */
export const CHANNELS = {
  recentProjects: 'janus:recent-projects',
  openProject: 'janus:open-project',
  openRecent: 'janus:open-recent',
  removeRecent: 'janus:remove-recent',
  newProject: 'janus:new-project',
  projectState: 'janus:project-state',
  retry: 'janus:retry',
  startOnFreePort: 'janus:start-on-free-port',
  openProblemFile: 'janus:open-problem-file',
  copyMockUrl: 'janus:copy-mock-url',
  showServerLog: 'janus:show-server-log',
  logLines: 'janus:log-lines',
  openLogFile: 'janus:open-log-file',
  projectStateChanged: 'janus:project-state-changed',
  logLineAdded: 'janus:log-line-added',
} as const;

/** The origin of the app's own pages. */
export const APP_SCHEME = 'janus-app';
export const APP_ORIGIN = 'janus-app://app';
