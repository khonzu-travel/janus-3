import { evaluateRequestToken, type GrammarContext, type RequestTokenEnvironment } from '@janus/core';

import { parseTemplate, substitutionText, type Template, type TemplateSegment } from './template.js';

/**
 * Variable scopes. A name's value comes from the first scope
 * that defines it: run variables, the request's `vars`, the environment
 * (`.local.yaml` first), then folder `vars` from the nearest folder out to the
 * collection. Request and folder values are templates rendered on use.
 */
export interface VariableScopes {
  /** Set by `extract` and scripts during the run, plus the run's starting values. */
  readonly run: Map<string, unknown>;
  readonly request: Readonly<Record<string, string>>;
  /** Plain strings, `.local.yaml` values already laid over the environment's. */
  readonly environment: Readonly<Record<string, string>>;
  /** Nearest folder first, the collection last. */
  readonly folders: readonly Readonly<Record<string, string>>[];
}

export type ScopeName = 'run' | 'request' | 'environment' | 'folder' | 'collection';

/** A template could not be rendered. */
export class RenderError extends Error {
  constructor(
    readonly code: 'unresolved-variable' | 'variable-cycle' | 'invalid-token',
    message: string,
    /** For `unresolved-variable`: every undefined name. */
    readonly names: readonly string[] = [],
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

/** Renders templates against scopes, collecting undefined names instead of stopping at the first. */
export class Renderer {
  readonly #scopes: VariableScopes;
  readonly #grammar: GrammarContext;
  readonly #tokens: RequestTokenEnvironment;
  readonly #missing = new Set<string>();

  constructor(scopes: VariableScopes, grammar: GrammarContext, tokens: RequestTokenEnvironment) {
    this.#scopes = scopes;
    this.#grammar = grammar;
    this.#tokens = tokens;
  }

  /** Names read so far that no scope defines. */
  get missing(): readonly string[] {
    return [...this.#missing];
  }

  /** Throws `unresolved-variable` naming every undefined variable read so far. */
  assertResolved(): void {
    const names = this.missing;
    if (names.length > 0) {
      throw new RenderError(
        'unresolved-variable',
        `${names.length === 1 ? 'Variable' : 'Variables'} ${names.map((name) => `"${name}"`).join(', ')} ${names.length === 1 ? 'is' : 'are'} not defined in any scope`,
        names,
      );
    }
  }

  /** Renders text; an undefined variable renders as "" and is remembered. */
  text(source: string): string {
    return this.#text(parseTemplate(source, { grammar: this.#grammar }).template, []);
  }

  /** The value of a variable, or undefined (remembered as missing) when no scope defines it. */
  value(name: string): unknown {
    return this.#value(name, []);
  }

  /** Where a variable comes from, for the editor; null when undefined. */
  scopeOf(name: string): ScopeName | null {
    const scopes = this.#scopes;
    if (scopes.run.has(name)) return 'run';
    if (Object.hasOwn(scopes.request, name)) return 'request';
    if (Object.hasOwn(scopes.environment, name)) return 'environment';
    const index = scopes.folders.findIndex((folder) => Object.hasOwn(folder, name));
    if (index === -1) return null;
    return index === scopes.folders.length - 1 ? 'collection' : 'folder';
  }

  /** Renders one segment's value: whole-value typing keeps a lone variable's or token's JSON type. */
  segmentValue(segment: TemplateSegment, trail: readonly string[] = []): unknown {
    switch (segment.kind) {
      case 'text':
        return segment.text;
      case 'variable':
        return this.#value(segment.name, trail);
      case 'token':
        try {
          return evaluateRequestToken(segment.token, this.#tokens);
        } catch (error) {
          throw new RenderError(
            'invalid-token',
            `${segment.text} cannot be computed: ${error instanceof Error ? error.message : 'unknown reason'}`,
          );
        }
      case 'exchange':
        throw new RenderError('invalid-token', `${segment.text} can only be read by extract`);
    }
  }

  #text(template: Template, trail: readonly string[]): string {
    let out = '';
    for (const segment of template.segments) out += substitutionText(this.segmentValue(segment, trail));
    return out;
  }

  #value(name: string, trail: readonly string[]): unknown {
    const scopes = this.#scopes;
    if (scopes.run.has(name)) return scopes.run.get(name);
    let template: string | undefined;
    if (Object.hasOwn(scopes.request, name)) template = scopes.request[name];
    else if (Object.hasOwn(scopes.environment, name)) return scopes.environment[name];
    else template = scopes.folders.find((folder) => Object.hasOwn(folder, name))?.[name];
    if (template === undefined) {
      this.#missing.add(name);
      return undefined;
    }
    if (trail.includes(name)) {
      throw new RenderError(
        'variable-cycle',
        `Variables refer to each other in a cycle: ${[...trail, name].join(' → ')}`,
      );
    }
    const parsed = parseTemplate(template, { grammar: this.#grammar }).template;
    const [only] = parsed.segments;
    // A value that is one variable or token keeps its type, as extract values do.
    if (parsed.segments.length === 1 && only !== undefined && only.kind !== 'text') {
      return this.segmentValue(only, [...trail, name]);
    }
    return this.#text(parsed, [...trail, name]);
  }
}
