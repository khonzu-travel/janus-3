import { contextBridge, ipcRenderer } from 'electron';

import { CHANNELS, type JanusAppBridge } from '../shared/bridge.js';

// The bridge for the app's own pages. Loaded only into windows
// showing janus-app://app/, never into an Atlas window. Every method is one
// IPC channel; the main process checks the sender and validates arguments.

// The main process sends only the channel's own type on each channel.
function subscribe(channel: string, listener: (value: never) => void): () => void {
  const handler = (_event: unknown, value: unknown): void => {
    (listener as (value: unknown) => void)(value);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: JanusAppBridge = {
  recentProjects: () => ipcRenderer.invoke(CHANNELS.recentProjects),
  openProject: () => ipcRenderer.invoke(CHANNELS.openProject),
  openRecent: (path) => ipcRenderer.invoke(CHANNELS.openRecent, path),
  removeRecent: (path) => ipcRenderer.invoke(CHANNELS.removeRecent, path),
  newProject: () => ipcRenderer.invoke(CHANNELS.newProject),
  projectState: () => ipcRenderer.invoke(CHANNELS.projectState),
  onProjectState: (listener) => subscribe(CHANNELS.projectStateChanged, listener),
  retry: () => ipcRenderer.invoke(CHANNELS.retry),
  startOnFreePort: () => ipcRenderer.invoke(CHANNELS.startOnFreePort),
  openProblemFile: (index) => ipcRenderer.invoke(CHANNELS.openProblemFile, index),
  copyMockUrl: () => ipcRenderer.invoke(CHANNELS.copyMockUrl),
  showServerLog: () => ipcRenderer.invoke(CHANNELS.showServerLog),
  logLines: () => ipcRenderer.invoke(CHANNELS.logLines),
  onLogLine: (listener) => subscribe(CHANNELS.logLineAdded, listener),
  openLogFile: () => ipcRenderer.invoke(CHANNELS.openLogFile),
};

contextBridge.exposeInMainWorld('janusApp', bridge);
