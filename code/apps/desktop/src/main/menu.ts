import type { MenuItemConstructorOptions } from 'electron';

/** What the focused window's project allows. */
export interface MenuState {
  readonly platform: NodeJS.Platform;
  readonly development: boolean;
  /** Null when the focused window has no project. */
  readonly project: {
    readonly running: boolean;
    readonly recording: boolean;
  } | null;
  readonly recent: readonly { readonly path: string; readonly name: string; readonly missing: boolean }[];
}

export interface MenuActions {
  readonly newProject: () => void;
  readonly openProject: () => void;
  readonly openRecent: (path: string) => void;
  readonly clearRecent: () => void;
  readonly importCollection: () => void;
  readonly restart: () => void;
  readonly reloadFixtures: () => void;
  readonly openConfiguration: () => void;
  readonly copyMockUrl: () => void;
  readonly openMockUrl: () => void;
  readonly showDataFolder: () => void;
  readonly showCapturesFolder: () => void;
  readonly showServerLog: () => void;
  readonly about: () => void;
  readonly closeWindow: () => void;
  readonly reloadPage: () => void;
  readonly zoom: (direction: 'reset' | 'in' | 'out') => void;
  readonly toggleFullScreen: () => void;
  readonly toggleDevTools: () => void;
}

/** The application menu. Server items follow the focused window's project. */
export function menuTemplate(state: MenuState, actions: MenuActions): MenuItemConstructorOptions[] {
  const mac = state.platform === 'darwin';
  const project = state.project;
  const hasProject = project !== null;
  const running = project?.running === true;

  const recent: MenuItemConstructorOptions[] = [
    ...state.recent.map((entry): MenuItemConstructorOptions => ({
      label: entry.name,
      sublabel: entry.path,
      toolTip: entry.path,
      enabled: !entry.missing,
      click: () => {
        actions.openRecent(entry.path);
      },
    })),
    ...(state.recent.length > 0 ? [{ type: 'separator' } as const] : []),
    { label: 'Clear', enabled: state.recent.length > 0, click: actions.clearRecent },
  ];

  const about: MenuItemConstructorOptions = { label: 'About Janus', click: actions.about };
  return [
    ...(mac
      ? [
          {
            label: 'Janus',
            submenu: [
              about,
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: actions.newProject },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: actions.openProject },
        { label: 'Open Recent', submenu: recent },
        { type: 'separator' },
        { label: 'Import Collection…', enabled: running, click: actions.importCollection },
        { type: 'separator' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: actions.closeWindow },
        ...(mac ? [] : [{ type: 'separator' } as const, { role: 'quit' } as const]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Server',
      submenu: [
        { label: 'Restart', accelerator: 'CmdOrCtrl+Shift+R', enabled: hasProject, click: actions.restart },
        { label: 'Reload Fixtures', enabled: running, click: actions.reloadFixtures },
        { label: 'Configuration…', enabled: running, click: actions.openConfiguration },
        { type: 'separator' },
        { label: 'Copy Mock URL', enabled: running, click: actions.copyMockUrl },
        { label: 'Open Mock URL in Browser', enabled: running, click: actions.openMockUrl },
        { type: 'separator' },
        { label: 'Show Data Folder', enabled: hasProject, click: actions.showDataFolder },
        { label: 'Show Captures Folder', enabled: project?.recording === true, click: actions.showCapturesFolder },
        { label: 'Show Server Log', accelerator: 'CmdOrCtrl+L', enabled: hasProject, click: actions.showServerLog },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: actions.reloadPage },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            actions.zoom('reset');
          },
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => {
            actions.zoom('in');
          },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            actions.zoom('out');
          },
        },
        { type: 'separator' },
        { label: 'Toggle Full Screen', accelerator: mac ? 'Ctrl+Cmd+F' : 'F11', click: actions.toggleFullScreen },
        ...(state.development
          ? [
              { type: 'separator' } as const,
              {
                label: 'Toggle Developer Tools',
                accelerator: mac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
                click: actions.toggleDevTools,
              },
            ]
          : []),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: mac ? [] : [about],
    },
  ];
}

/** `Janus — <project name> — <state>`. */
export function windowTitle(name: string, state: string): string {
  return `Janus — ${name} — ${state}`;
}
