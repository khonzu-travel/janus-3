import { JSONPath } from 'jsonpath-plus';

/**
 * `body.<JSONPath>` through `jsonpath-plus`. Filter
 * expressions use its sandboxed evaluator, never `eval` or `Function`.
 */

/**
 * Why a JSONPath cannot be used, or null. It is run against small sample
 * documents, so filter expressions are parsed; no request data is involved.
 */
export function checkJsonPath(path: string): string | null {
  if (!path.startsWith('$'))
    return `body values take a JSONPath starting with "$", e.g. body.$.customer.name; got "${path}"`;
  try {
    for (const json of SAMPLES) JSONPath({ path: literalAttributes(path), json, wrap: true, eval: 'safe' });
    return null;
  } catch (error) {
    return `"${path}" is not a valid JSONPath${error instanceof Error ? `: ${error.message}` : ''}`;
  }
}

const SAMPLES: readonly object[] = [{ a: {} }, [{}]];

/** The first match in document order, or undefined when nothing matches. */
export function firstMatch(path: string, document: unknown): unknown {
  const matches = JSONPath({ path: literalAttributes(path), json: document, wrap: true, eval: 'safe' });
  return Array.isArray(matches) ? matches[0] : undefined;
}

/**
 * jsonpath-plus reads a step starting with `@` as a type selector such as
 * `@string()`, so the XML document's `@<attribute>` members
 * are escaped with its backtick: `.@id` and `['@id']` become `` .`@id ``.
 */
function literalAttributes(path: string): string {
  let out = '';
  for (let index = 0; index < path.length;) {
    if (path[index] === '[') {
      // Keep filters, script expressions and quoted property names intact.
      // Their brackets can nest, and quoted strings can contain brackets.
      let end = index + 1;
      let depth = 1;
      let quote: string | null = null;
      for (; end < path.length && depth > 0; end++) {
        const char = path[end];
        if (quote !== null) {
          if (char === '\\') end++;
          else if (char === quote) quote = null;
        } else if (char === "'" || char === '"') quote = char;
        else if (char === '[') depth++;
        else if (char === ']') depth--;
      }
      const step = path.slice(index, end);
      out += step.replace(/^\[(['"])@([^'"\]]*)\1\]$/, (_match, _quote: string, name: string) => `[\`@${name}]`);
      index = end;
    } else {
      const attribute = /^\.@(?=[^.[\]()]+(?:$|[.[]))/.exec(path.slice(index));
      if (attribute !== null) {
        out += '.`@';
        index += 2;
      } else {
        out += path.charAt(index);
        index++;
      }
    }
  }
  return out;
}
