import type { NameValue } from '../model.js';
import { base64Encode, encodeUtf8 } from './text.js';
import { convertTemplate, type Note, type TemplateDialect } from './template.js';

/**
 * Postman and Bruno auth as headers and query parameters. Auth declared on a folder becomes a
 * header in its `folder.yaml`; a
 * request or folder that sets its own auth, or none, disables the inherited
 * header by repeating its name with `disabled: true`.
 */

export type SourceAuth =
  | { readonly type: 'inherit' }
  | { readonly type: 'none' }
  | { readonly type: 'bearer'; readonly token: string }
  | { readonly type: 'basic'; readonly username: string; readonly password: string }
  | { readonly type: 'apikey'; readonly key: string; readonly value: string; readonly in: 'header' | 'query' }
  | { readonly type: 'other'; readonly name: string };

/** The variable a basic-auth header refers to when its credentials are templates. */
export const BASIC_AUTH_VARIABLE = 'basicAuth';

/** What the nearest ancestor's auth provides to the items below it. */
export interface AuthScope {
  /** The inherited header's name. */
  readonly header: string | null;
  /** An inherited API key query parameter, added to each request that inherits it. */
  readonly query: { readonly name: string; readonly value: string; readonly from: string } | null;
}

export const NO_AUTH_SCOPE: AuthScope = Object.freeze({ header: null, query: null });

export interface AppliedAuth {
  /** Headers for the request or folder, before its own. */
  readonly headers: readonly NameValue[];
  /** A query parameter to add to a request's URL. */
  readonly query: { readonly name: string; readonly value: string } | null;
  /** What items below inherit. */
  readonly scope: AuthScope;
}

/**
 * Applies a request's or folder's auth under what it inherits. `label` names
 * the item in the scope it passes on, for notes about inherited query keys.
 */
export function applyAuth(
  auth: SourceAuth,
  inherited: AuthScope,
  dialect: TemplateDialect,
  label: string,
  note: Note,
): AppliedAuth {
  const disableInherited: NameValue[] =
    inherited.header === null ? [] : [{ name: inherited.header, value: '', disabled: true }];
  switch (auth.type) {
    case 'inherit':
      return { headers: [], query: inherited.query, scope: inherited };
    case 'none':
      return { headers: disableInherited, query: null, scope: NO_AUTH_SCOPE };
    case 'other':
      note(`auth type "${auth.name}" was not converted; add its header or script by hand`);
      return { headers: disableInherited, query: null, scope: NO_AUTH_SCOPE };
    case 'bearer': {
      const header = { name: 'Authorization', value: `Bearer ${convertTemplate(auth.token, dialect, note)}` };
      return { headers: [...disableInherited, header], query: null, scope: { header: header.name, query: null } };
    }
    case 'basic': {
      const header = { name: 'Authorization', value: basicValue(auth.username, auth.password, dialect, note) };
      return { headers: [...disableInherited, header], query: null, scope: { header: header.name, query: null } };
    }
    case 'apikey': {
      const value = convertTemplate(auth.value, dialect, note);
      if (auth.key.trim() === '') {
        note('the API key auth has no key name and was not converted');
        return { headers: disableInherited, query: null, scope: NO_AUTH_SCOPE };
      }
      if (auth.in === 'query') {
        const query = { name: auth.key, value };
        return { headers: disableInherited, query, scope: { header: null, query: { ...query, from: label } } };
      }
      const header = { name: auth.key, value };
      return { headers: [...disableInherited, header], query: null, scope: { header: header.name, query: null } };
    }
  }
}

/**
 * `Basic <base64>` when both credentials are literal. Templates cannot be
 * encoded at import time, so the header then refers to {@link BASIC_AUTH_VARIABLE},
 * which fails the step as an undefined variable until it is set.
 */
function basicValue(username: string, password: string, dialect: TemplateDialect, note: Note): string {
  const user = convertTemplate(username, dialect, note);
  const pass = convertTemplate(password, dialect, note);
  if (!`${user}${pass}`.includes('{{')) return `Basic ${base64Encode(encodeUtf8(`${user}:${pass}`))}`;
  note(
    `basic auth uses variables (${username}:${password}), which cannot be encoded at import time; ` +
      `the header reads "Basic {{${BASIC_AUTH_VARIABLE}}}": set ${BASIC_AUTH_VARIABLE} to the base64 of user:password`,
  );
  return `Basic {{${BASIC_AUTH_VARIABLE}}}`;
}
