import { CookieJar } from 'tough-cookie';

import type { HeaderLine } from '@janus/core';

/**
 * A run's cookie jar: `Set-Cookie` headers in responses are
 * stored, and later requests in the run send the matching cookies after any
 * `Cookie` header the request writes itself. Dropped when the run ends. Expiry is checked against the wall clock.
 */
export class RunCookies {
  readonly #jar = new CookieJar(undefined, { rejectPublicSuffixes: false, looseMode: true });
  /** The request's headers with the jar's matching cookies added for `url`. */
  async apply(url: string, headers: readonly HeaderLine[]): Promise<readonly HeaderLine[]> {
    const cookies = await this.#jar.getCookieString(url).catch(() => '');
    if (cookies === '') return headers;
    const index = headers.findIndex(([name]) => name.toLowerCase() === 'cookie');
    if (index === -1) return [...headers, ['Cookie', cookies]];
    return headers.map((line, position) => (position === index ? [line[0], `${line[1]}; ${cookies}`] : line));
  }

  /** Stores the response's cookies for `url`; a cookie the jar refuses is skipped. */
  async store(url: string, headers: readonly HeaderLine[]): Promise<void> {
    for (const [name, value] of headers) {
      if (name.toLowerCase() !== 'set-cookie') continue;
      await this.#jar.setCookie(value, url, { ignoreError: true }).catch(() => undefined);
    }
  }
}
