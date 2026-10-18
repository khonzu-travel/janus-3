import { describe, expect, it } from 'vitest';

import { checkJsonPath, firstMatch } from './jsonpath.js';

describe('XML attribute steps in JSONPath', () => {
  const document = {
    order: {
      '@id': 'o-1',
      item: [
        { '@sku': 'a', value: 'first' },
        { '@sku': 'b', value: 'second' },
      ],
    },
  };

  it('reads literal attribute steps in dot and bracket notation', () => {
    expect(firstMatch('$.order.@id', document)).toBe('o-1');
    expect(firstMatch("$.order['@id']", document)).toBe('o-1');
    expect(firstMatch("$.order.item[1]['@sku']", document)).toBe('b');
  });

  it('preserves attribute access and string literals in filters', () => {
    const path = "$.order.item[?(@['@sku'] == 'b')].value";
    expect(checkJsonPath(path)).toBeNull();
    expect(firstMatch(path, document)).toBe('second');
    expect(firstMatch("$.items[?(@.value == 'x.@id.y')].value", { items: [{ value: 'x.@id.y' }] })).toBe('x.@id.y');
  });

  it('preserves JSONPath type selectors', () => {
    expect(firstMatch('$.items.*.@string()', { items: [1, 'text'] })).toBe('text');
  });
});
