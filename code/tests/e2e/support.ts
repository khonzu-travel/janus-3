import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

// Shared steps of the browser journeys: input drivers for the mouse
// and keyboard-only runs, the axe-core audit, and temporary fixture trees.

export type InputMode = 'mouse' | 'keyboard';
export const INPUT_MODES: readonly InputMode[] = ['mouse', 'keyboard'];

/** Every interaction a journey makes, so the same journey runs by mouse or by keyboard alone. */
export interface Driver {
  readonly mode: InputMode;
  /** Follows a link or presses a button. */
  activate(target: Locator): Promise<void>;
  /** Replaces the text of a field. */
  fill(target: Locator, text: string): Promise<void>;
  /** Selects a tab: a click, or Tab to the selected tab and the arrow keys from there. */
  chooseTab(target: Locator): Promise<void>;
  /** Moves a resize handle sideways by about `dx` px: a drag, or arrow keys in 16 px steps. */
  nudge(target: Locator, dx: number): Promise<void>;
}

export function driver(page: Page, mode: InputMode): Driver {
  if (mode === 'mouse') {
    return {
      mode,
      activate: (target) => target.click(),
      fill: (target, text) => target.fill(text),
      chooseTab: (target) => target.click(),
      nudge: async (target, dx) => {
        const box = await target.boundingBox();
        if (box === null) throw new Error('nudge: the handle is not on screen');
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + dx, y, { steps: 4 });
        await page.mouse.up();
      },
    };
  }
  return {
    mode,
    activate: async (target) => {
      await tabTo(page, target);
      await page.keyboard.press('Enter');
    },
    fill: async (target, text) => {
      await tabTo(page, target);
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(text);
    },
    chooseTab: async (target) => {
      const list = target.locator('xpath=ancestor::*[@role="tablist"][1]');
      await tabTo(page, list.getByRole('tab', { selected: true }));
      for (let step = 0; step < 10 && (await target.getAttribute('aria-selected')) !== 'true'; step++) {
        await page.keyboard.press('ArrowRight');
      }
      await expect(target).toBeFocused();
    },
    nudge: async (target, dx) => {
      await tabTo(page, target);
      for (let step = 0; step < Math.round(Math.abs(dx) / 16); step++) {
        await page.keyboard.press(dx > 0 ? 'ArrowRight' : 'ArrowLeft');
      }
    },
  };
}

const MAX_TABS = 400;

// The browser globals the page functions below use, declared for this module
// alone: the tests compile without the DOM library.
interface BrowserElement {
  matches(selector: string): boolean;
  compareDocumentPosition(other: BrowserElement): number;
}
declare const document: { readonly activeElement: BrowserElement | null; readonly body: BrowserElement };
declare const Node: { readonly DOCUMENT_POSITION_FOLLOWING: number };
declare function getComputedStyle(element: BrowserElement): {
  readonly outlineStyle: string;
  readonly outlineWidth: string;
  readonly boxShadow: string;
};

/**
 * Moves focus to `target` with Tab or Shift+Tab alone, the way a keyboard user
 * would, and checks that focus is visible when it gets there.
 */
export async function tabTo(page: Page, target: Locator): Promise<void> {
  await target.waitFor({ state: 'visible' });
  for (let presses = 0; presses < MAX_TABS; presses++) {
    const where = await target.evaluate((element: BrowserElement) => {
      const active = document.activeElement;
      if (active === element) return 'here';
      if (active === null || active === document.body) return 'after';
      return (active.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ? 'after' : 'before';
    });
    if (where === 'here') {
      await expectFocusVisible(target);
      return;
    }
    await page.keyboard.press(where === 'after' ? 'Tab' : 'Shift+Tab');
  }
  throw new Error(`not reachable with Tab: ${String(target)}`);
}

/** The computed outline style of an element. */
export function outlineStyle(target: Locator): Promise<string> {
  return target.evaluate((element: BrowserElement) => getComputedStyle(element).outlineStyle);
}

/** Focus is shown by an outline or a ring. */
export async function expectFocusVisible(target: Locator): Promise<void> {
  const shown = await target.evaluate((element: BrowserElement) => {
    const style = getComputedStyle(element);
    const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
    return element.matches(':focus-visible') && (outline || style.boxShadow !== 'none');
  });
  expect(shown, `focus is visible on ${String(target)}`).toBe(true);
}

/**
 * The axe-core audit of the current view, in the light and the
 * dark theme, with no violations at any impact level. It runs in Chromium and
 * once per journey state, since axe's rules do not depend on the engine.
 */
/** Picks a scenario in the header's scenario picker. */
export async function pickScenario(page: Page, name: string): Promise<void> {
  await page
    .getByRole('banner')
    .getByRole('button', { name: /^Scenario / })
    .click();
  await page.getByRole('listbox', { name: 'Scenarios' }).getByRole('option', { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`scenario=${name}(&|$)`));
}

/** The Requests tab's editor in front; the other open tabs stay mounted but hidden. */
export function frontEditor(page: Page): Locator {
  return page.locator('[data-editor]:not([hidden])');
}

export async function audit(page: Page, info: TestInfo, mode: InputMode, view: string): Promise<void> {
  if (info.project.name !== 'chromium' || mode !== 'mouse') return;
  // Let any pending render settle, so the audit sees the finished view.
  await page.evaluate('new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50)))');
  // A theme chosen in the page outranks the system setting: audit that theme alone.
  const chosen: string | null = await page.evaluate("localStorage.getItem('janus-atlas-theme')");
  const schemes: readonly ('light' | 'dark')[] = chosen === 'light' || chosen === 'dark' ? [chosen] : ['light', 'dark'];
  for (const scheme of schemes) {
    if (chosen === null) await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    const { violations } = await new AxeBuilder({ page }).analyze();
    const found = violations.map(
      (violation) =>
        `${violation.id} (${String(violation.impact)}): ${violation.nodes
          .slice(0, 3)
          .map((node) => node.target.join(' '))
          .join(', ')}`,
    );
    expect(found, `axe violations in ${view}, ${scheme} theme`).toEqual([]);
  }
  if (chosen === null) await page.emulateMedia({ colorScheme: 'light' });
}

/** The inventory, wherever the layout puts it: beside the details, in the drawer, or as its own view. */
export async function showInventory(page: Page, input: Driver): Promise<Locator> {
  const nav = page.getByRole('navigation', { name: 'Endpoints' });
  await expect(page.getByRole('banner').getByRole('status')).toHaveText(/Ready|Snapshot changed/);
  // Requests is the home page; the endpoint list is the Endpoints view.
  const view = page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Endpoints' });
  if ((await view.getAttribute('aria-current')) !== 'page') {
    await input.activate(view);
    await expect(nav).toBeVisible();
  }
  if (await nav.isVisible()) return nav;
  // At 768 px and below the list is its own view; endpoint details link back to it.
  await input.activate(page.getByRole('link', { name: '← All endpoints' }));
  await expect(nav).toBeVisible();
  return nav;
}

/** Opens the folders on the way to an endpoint that start collapsed. */
export async function revealFolder(nav: Locator, input: Driver, name: string): Promise<void> {
  const folder = nav.getByRole('button', { name, exact: true });
  if ((await folder.getAttribute('aria-expanded')) === 'false') await input.activate(folder);
}

/** Writes a fixture tree under a new temporary directory and returns the directory. */
export async function writeTree(prefix: string, files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  return root;
}

/** Fails when the page scrolls sideways (at 320 px only code previews scroll). */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow: number = await page.evaluate('document.documentElement.scrollWidth - window.innerWidth');
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

/** JSON bodies open as Text in this page, so a test can read them as the text they are. */
export async function bodiesAsText(page: Page): Promise<void> {
  await page.addInitScript("window.localStorage.setItem('janus-body-as-text', '1')");
}
