import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import { firstMatch } from '../dynamic/jsonpath.js';
import { decodeXmlBody, isXmlMediaType, MAX_XML_DEPTH, MAX_XML_NODES } from './xml.js';

const decode = (xml: string, contentType = 'application/xml') => decodeXmlBody(utf8Encode(xml), contentType);

const documentOf = (xml: string, contentType?: string) => {
  const result = decode(xml, contentType);
  if (!result.ok) throw new Error(`expected a document, got: ${result.reason}`);
  return result.document;
};

const reasonOf = (xml: string | Uint8Array, contentType = 'application/xml') => {
  const result = typeof xml === 'string' ? decode(xml, contentType) : decodeXmlBody(xml, contentType);
  if (result.ok) throw new Error('expected a failure');
  return result.reason;
};

const nested = (depth: number) => '<e>'.repeat(depth) + '</e>'.repeat(depth);

describe('isXmlMediaType', () => {
  it('accepts application/xml, text/xml and +xml types, case-insensitively and with parameters', () => {
    for (const value of [
      'application/xml',
      'text/xml',
      'Application/XML; charset=utf-8',
      'application/soap+xml',
      'image/svg+xml',
      'application/atom+XML ;q=1',
    ]) {
      expect(isXmlMediaType(value), value).toBe(true);
    }
  });

  it('rejects other types', () => {
    for (const value of [
      'application/json',
      'text/plain',
      'application/xml-dtd',
      'application/+xml',
      'xml',
      '',
      '+xml',
    ]) {
      expect(isXmlMediaType(value), value).toBe(false);
    }
  });
});

describe('decodeXmlBody: the document', () => {
  it('reads the section 10.2 example exactly', () => {
    const document = documentOf(`<ord:order xmlns:ord="urn:shop" id="o-7" priority="high">
  <item sku="p-1">Chair</item>
  <item sku="p-2">Table</item>
  <note>Leave at the door</note>
  <gift/>
</ord:order>`);
    expect(document).toEqual({
      order: {
        '@id': 'o-7',
        '@priority': 'high',
        item: [
          { '@sku': 'p-1', '#text': 'Chair' },
          { '@sku': 'p-2', '#text': 'Table' },
        ],
        note: 'Leave at the door',
        gift: '',
      },
    });
    expect(firstMatch('$.order.@priority', document)).toBe('high');
    expect(firstMatch('$.order.item[1].@sku', document)).toBe('p-2');
    expect(firstMatch('$.order.note', document)).toBe('Leave at the door');
  });

  it('reads a root with only text as a string, empty roots as ""', () => {
    expect(documentOf('<a>hi</a>')).toEqual({ a: 'hi' });
    expect(documentOf('<a></a>')).toEqual({ a: '' });
    expect(documentOf('<a/>')).toEqual({ a: '' });
  });

  it('reads an element with attributes but no text as an object without #text', () => {
    expect(documentOf('<a x="1"/>')).toEqual({ a: { '@x': '1' } });
    expect(documentOf('<a x="1">  </a>')).toEqual({ a: { '@x': '1' } });
  });

  it('keeps every value a string', () => {
    expect(documentOf('<a n="2"><b>3</b><c>true</c><d>null</d></a>')).toEqual({
      a: { '@n': '2', b: '3', c: 'true', d: 'null' },
    });
  });

  it('reads a name once as a single value and repeats as an array in document order', () => {
    expect(documentOf('<a><b>1</b><c>x</c><b>2</b><b>3</b></a>')).toEqual({ a: { b: ['1', '2', '3'], c: 'x' } });
    expect(documentOf('<a><b><c>1</c></b></a>')).toEqual({ a: { b: { c: '1' } } });
  });

  it('removes prefixes and drops namespace declarations', () => {
    expect(
      documentOf('<p:a xmlns="urn:d" xmlns:p="urn:p" xmlns:q="urn:q" q:id="7"><p:b>1</p:b><c q:k="v"/></p:a>'),
    ).toEqual({ a: { '@id': '7', b: '1', c: { '@k': 'v' } } });
  });

  it('treats the same local name in different namespaces as repeats', () => {
    expect(documentOf('<a xmlns:x="urn:x" xmlns:y="urn:y"><x:b>1</x:b><y:b>2</y:b><b>3</b></a>')).toEqual({
      a: { b: ['1', '2', '3'] },
    });
  });

  it('concatenates mixed content exactly, without trimming', () => {
    expect(documentOf('<a> one <b>x</b> two </a>')).toEqual({ a: { b: 'x', '#text': ' one  two ' } });
    expect(documentOf('<a>  padded  </a>')).toEqual({ a: '  padded  ' });
    expect(documentOf('<a>line 1\n  line 2\n</a>')).toEqual({ a: 'line 1\n  line 2\n' });
  });

  it('ignores whitespace-only text, including the indentation between children', () => {
    expect(documentOf('<a>\n  <b>1</b>\n  <c/>\n</a>')).toEqual({ a: { b: '1', c: '' } });
    expect(documentOf('<a> \t\n </a>')).toEqual({ a: '' });
  });

  it('keeps non-XML whitespace such as a no-break space as text', () => {
    expect(documentOf('<a> </a>')).toEqual({ a: ' ' });
  });

  it('includes CDATA in the text, verbatim', () => {
    expect(documentOf('<a><![CDATA[<b>&amp;</b>]]></a>')).toEqual({ a: '<b>&amp;</b>' });
    expect(documentOf('<a>x<![CDATA[ y ]]>z<b/></a>')).toEqual({ a: { b: '', '#text': 'x y z' } });
    expect(documentOf('<a><![CDATA[   ]]></a>')).toEqual({ a: '' });
    expect(documentOf('<a><![CDATA[<!DOCTYPE example>]]></a>')).toEqual({ a: '<!DOCTYPE example>' });
    expect(documentOf('<!-- <!DOCTYPE example> --><a/>')).toEqual({ a: '' });
  });

  it('decodes the predefined entities and character references in text and attributes', () => {
    expect(documentOf('<a v="&quot;&apos;&lt;&#65;">&lt;&gt;&amp;&quot;&apos; &#65;&#x42;&#x1F600;</a>')).toEqual({
      a: { '@v': `"'<A`, '#text': `<>&"' AB\u{1F600}` },
    });
  });

  it('normalises line breaks, and tabs and newlines in attribute values', () => {
    expect(documentOf('<a v="x\ty\r\nz">1\r\n2\r3</a>')).toEqual({ a: { '@v': 'x y z', '#text': '1\n2\n3' } });
    expect(documentOf('<a v="x&#10;y"/>')).toEqual({ a: { '@v': 'x\ny' } });
  });

  it('ignores comments, processing instructions and the XML declaration', () => {
    expect(
      documentOf(
        '<?xml version="1.0" encoding="UTF-8"?>\n<!-- c --><?app go?>\n<a>x<!-- in -->y<?pi z?><b/></a>\n<!-- after -->',
      ),
    ).toEqual({ a: { b: '', '#text': 'xy' } });
  });

  it('accepts single-quoted attributes and whitespace inside tags', () => {
    expect(documentOf('<a  x = \'it"s\'\n y="1" ><b  /></a >')).toEqual({ a: { '@x': 'it"s', '@y': '1', b: '' } });
  });

  it('keeps names like __proto__ and constructor as ordinary members, without polluting prototypes', () => {
    const document = documentOf(
      '<__proto__ constructor="c"><constructor>1</constructor><__proto__ polluted="yes"/><toString>2</toString><hasOwnProperty/></__proto__>',
    );
    expect(Object.keys(document)).toEqual(['__proto__']);
    const root = document['__proto__'] as Record<string, unknown>;
    expect(Object.keys(root)).toEqual(['@constructor', 'constructor', '__proto__', 'toString', 'hasOwnProperty']);
    expect(root['constructor']).toBe('1');
    expect(root['__proto__']).toEqual({ '@polluted': 'yes' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(firstMatch('$.__proto__.constructor', document)).toBe('1');
    expect(firstMatch('$.__proto__.toString', document)).toBe('2');
    expect(firstMatch('$.__proto__.__proto__', document)).toEqual({ '@polluted': 'yes' });
    expect('toString' in documentOf('<a/>')).toBe(false);
  });

  it('freezes the document', () => {
    const document = documentOf('<a x="1"><b>1</b><b>2</b></a>');
    const root = document['a'] as Record<string, unknown>;
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root['b'])).toBe(true);
  });
});

describe('decodeXmlBody: limits and safety', () => {
  it('rejects a document type declaration', () => {
    const doctype = 'the XML body has a document type declaration, which is not allowed';
    expect(reasonOf('<!DOCTYPE a><a/>')).toBe(doctype);
    expect(reasonOf('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toBe(doctype);
    expect(reasonOf('<!DOCTYPE a SYSTEM "file:///etc/passwd"><a/>')).toBe(doctype);
  });

  it('rejects entity references other than the five predefined ones', () => {
    const entity = 'the XML body references an entity other than the five predefined ones';
    expect(reasonOf('<a>&nbsp;</a>')).toBe(entity);
    expect(reasonOf('<a>&copy;</a>')).toBe(entity);
    expect(reasonOf('<a x="&foo;"/>')).toBe(entity);
  });

  it('rejects a bare ampersand and malformed or disallowed character references', () => {
    expect(reasonOf('<a>fish & chips</a>')).toBe('the XML body has an "&" that does not begin a reference');
    expect(reasonOf('<a>&amp</a>')).toBe('the XML body has an "&" that does not begin a reference');
    expect(reasonOf('<a>&#xZZ;</a>')).toBe('the XML body has an "&" that does not begin a reference');
    expect(reasonOf('<a>&#0;</a>')).toMatch(/character reference/);
    expect(reasonOf('<a>&#xD800;</a>')).toMatch(/character reference/);
    expect(reasonOf('<a>&#x110000;</a>')).toMatch(/character reference/);
  });

  it('allows 64 levels of nesting and rejects 65', () => {
    expect(MAX_XML_DEPTH).toBe(64);
    expect(decode(nested(MAX_XML_DEPTH)).ok).toBe(true);
    expect(reasonOf(nested(MAX_XML_DEPTH + 1))).toBe('the XML body nests elements deeper than 64 levels');
    // Rejected while scanning: the rest of the document is never read.
    expect(reasonOf(`${nested(MAX_XML_DEPTH + 1)}<oops`)).toBe('the XML body nests elements deeper than 64 levels');
  });

  it('allows 10 000 elements and rejects one more', () => {
    expect(MAX_XML_NODES).toBe(10_000);
    const elements = (count: number) => `<r>${'<i/>'.repeat(count - 1)}</r>`;
    const ok = decode(elements(MAX_XML_NODES));
    expect(ok.ok && (ok.document['r'] as { i: unknown[] }).i.length).toBe(MAX_XML_NODES - 1);
    expect(reasonOf(elements(MAX_XML_NODES + 1))).toBe('the XML body has more than 10000 elements and attributes');
  });

  it('counts attributes, namespace declarations included, towards the node limit', () => {
    const attributes = (count: number) =>
      `<r xmlns:p="urn:p">${'<i a="1" b="2"/>'.repeat(Math.floor(count / 3))}${'<j/>'.repeat(count % 3)}</r>`;
    // Root + its declaration are 2 nodes; each <i> is 3.
    expect(decode(attributes(MAX_XML_NODES - 2)).ok).toBe(true);
    expect(reasonOf(attributes(MAX_XML_NODES - 1))).toBe('the XML body has more than 10000 elements and attributes');
  });

  it('accepts UTF-8 with or without a byte order mark', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Encode('<a>café</a>')]);
    expect(decodeXmlBody(bom, 'text/xml')).toEqual({ ok: true, document: { a: 'café' } });
    expect(documentOf('<?xml version="1.0" encoding="utf-8"?><a/>')).toEqual({ a: '' });
    expect(documentOf("<?xml version='1.0' encoding='UTF-8' standalone='yes'?><a/>")).toEqual({ a: '' });
    expect(documentOf('<a/>', 'application/xml; charset=UTF-8')).toEqual({ a: '' });
    expect(documentOf('<a/>', 'application/xml; charset="utf-8"')).toEqual({ a: '' });
  });

  it('rejects another declared encoding, another charset and invalid UTF-8', () => {
    expect(reasonOf('<?xml version="1.0" encoding="ISO-8859-1"?><a/>')).toBe(
      'the XML body must be UTF-8, but its XML declaration names another encoding',
    );
    expect(reasonOf('<a/>', 'application/xml; charset=latin1')).toBe(
      'the XML body must be UTF-8, but the Content-Type names another charset',
    );
    expect(reasonOf(new Uint8Array([0x3c, 0x61, 0x3e, 0xe9, 0x3c, 0x2f, 0x61, 0x3e]))).toBe(
      'the XML body is not valid UTF-8',
    );
  });

  it('rejects malformed documents', () => {
    const cases: [string, RegExp][] = [
      ['', /no root element/],
      ['   ', /no root element/],
      ['<!-- only a comment -->', /no root element/],
      ['<a>', /unclosed element/],
      ['<a><b></a>', /does not match/],
      ['<a></b>', /does not match/],
      ['</a>', /not well-formed/],
      ['<a/><b/>', /more than one root/],
      ['<a/>text', /text outside/],
      ['text<a/>', /text outside/],
      ['<a x="1" x="2"/>', /repeats an attribute/],
      ['<a p:x="1" q:x="2"/>', /repeats an attribute/],
      ['<a x=1/>', /not well-formed/],
      ['<a x/>', /not well-formed/],
      ['<a x="1"y="2"/>', /not well-formed/],
      ['<a x="<"/>', /not well-formed/],
      ['<a x="1/>', /not well-formed/],
      ['<1a/>', /not well-formed/],
      ['< a/>', /not well-formed/],
      ['<a:b:c/>', /not well-formed/],
      ['<a><!-- open </a>', /not well-formed/],
      ['<a><![CDATA[ open </a>', /not well-formed/],
      ['<![CDATA[x]]><a/>', /not well-formed/],
      ['<a>]]></a>', /not well-formed/],
      ['<a/><?xml version="1.0"?>', /not well-formed/],
      ['<a>\u0001</a>', /character that XML does not allow/],
      ['<a', /not well-formed/],
    ];
    for (const [xml, reason] of cases) expect(reasonOf(xml), JSON.stringify(xml)).toMatch(reason);
  });

  it('never quotes request content in a reason', () => {
    for (const xml of ['<secret>', '<a>&secret;</a>', '<secret/><secret/>', '<a></secret>']) {
      expect(reasonOf(xml)).not.toContain('secret');
    }
  });
});
