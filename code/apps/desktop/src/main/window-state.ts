import { readJson, writeFileAtomic } from './atomic-file.js';

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_SIZE = { width: 1280, height: 800 } as const;
export const MIN_SIZE = { width: 800, height: 560 } as const;

/**
 * Fits saved bounds onto the displays there are now: kept when
 * the window's title bar area is on a display, otherwise moved onto the
 * nearest work area and shrunk to fit it. Null without a display.
 */
export function clampBounds(bounds: Bounds, workAreas: readonly Bounds[]): Bounds | null {
  const first = workAreas[0];
  if (first === undefined) return null;
  const visible = workAreas.find((area) => intersects({ ...bounds, height: Math.min(bounds.height, 40) }, area));
  const area = visible ?? nearest(bounds, workAreas) ?? first;
  const width = Math.max(Math.min(bounds.width, area.width), Math.min(MIN_SIZE.width, area.width));
  const height = Math.max(Math.min(bounds.height, area.height), Math.min(MIN_SIZE.height, area.height));
  if (visible !== undefined && width === bounds.width && height === bounds.height) return bounds;
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function nearest(bounds: Bounds, areas: readonly Bounds[]): Bounds | undefined {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const distance = (area: Bounds): number => Math.hypot(area.x + area.width / 2 - cx, area.y + area.height / 2 - cy);
  return [...areas].sort((a, b) => distance(a) - distance(b))[0];
}

function isBounds(value: unknown): value is Bounds {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y, width, height } = value as Record<string, unknown>;
  return (
    [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    (width as number) > 0 &&
    (height as number) > 0
  );
}

/** `window-state.json`: each project's window bounds by project id. */
export class WindowStates {
  private states = new Map<string, Bounds>();
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {}

  static async load(file: string, log: (line: string) => void): Promise<WindowStates> {
    const store = new WindowStates(file);
    try {
      const data = await readJson(file);
      const windows = (data as { windows?: unknown } | null)?.windows;
      if (typeof windows === 'object' && windows !== null) {
        for (const [id, bounds] of Object.entries(windows)) if (isBounds(bounds)) store.states.set(id, bounds);
      } else if (data !== null) {
        log(`window-state-invalid file=${JSON.stringify(file)}`);
      }
    } catch (error) {
      log(`window-state-unreadable file=${JSON.stringify(file)} reason=${JSON.stringify(String(error))}`);
    }
    return store;
  }

  get(id: string): Bounds | undefined {
    return this.states.get(id);
  }

  save(id: string, bounds: Bounds): Promise<void> {
    this.states.set(id, bounds);
    const contents = `${JSON.stringify({ version: 1, windows: Object.fromEntries(this.states) }, null, 2)}\n`;
    this.writing = this.writing.catch(() => undefined).then(() => writeFileAtomic(this.file, contents));
    return this.writing;
  }
}
