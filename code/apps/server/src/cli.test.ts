import { describe, expect, it } from 'vitest';

import { parseCommand } from './cli.js';

describe('parseCommand', () => {
  it('leaves unset options absent so the file and defaults apply', () => {
    expect(parseCommand(['serve'])).toEqual({ kind: 'serve', args: { noConfig: false } });
    expect(parseCommand(['validate'])).toEqual({
      kind: 'validate',
      args: { noConfig: false, strict: false, requireReviewed: false, format: 'text' },
    });
  });

  it('accepts every option, in either form', () => {
    expect(
      parseCommand(['serve', '--config', 'janus.config.yaml', '--data', 'fx', '--host=0.0.0.0', '--port', '0']),
    ).toEqual({
      kind: 'serve',
      args: { noConfig: false, config: 'janus.config.yaml', data: 'fx', host: '0.0.0.0', port: 0 },
    });
    expect(
      parseCommand([
        'validate',
        '--no-config',
        '--data=fx',
        '--host',
        'localhost',
        '--port',
        '4020',
        '--strict',
        '--format',
        'json',
      ]),
    ).toEqual({
      kind: 'validate',
      args: {
        noConfig: true,
        data: 'fx',
        host: 'localhost',
        port: 4020,
        strict: true,
        requireReviewed: false,
        format: 'json',
      },
    });
  });

  it('parses --watch for serve only', () => {
    expect(parseCommand(['serve', '--watch'])).toEqual({ kind: 'serve', args: { noConfig: false, watch: true } });
    expect(parseCommand(['validate', '--watch'])).toMatchObject({
      kind: 'usage-error',
      message: 'option --watch applies only to serve',
    });
    expect(parseCommand(['serve', '--watch=yes'])).toMatchObject({ kind: 'usage-error' });
  });

  it('parses --require-reviewed for validate only', () => {
    expect(parseCommand(['validate', '--require-reviewed'])).toEqual({
      kind: 'validate',
      args: { noConfig: false, strict: false, requireReviewed: true, format: 'text' },
    });
  });

  it('parses --no-ui for serve and validate', () => {
    expect(parseCommand(['serve', '--no-ui'])).toEqual({ kind: 'serve', args: { noConfig: false, noUi: true } });
    expect(parseCommand(['validate', '--no-ui'])).toEqual({
      kind: 'validate',
      args: { noConfig: false, noUi: true, strict: false, requireReviewed: false, format: 'text' },
    });
    expect(parseCommand(['serve', '--no-ui=yes'])).toMatchObject({ kind: 'usage-error' });
  });

  it('parses --seed and --now for serve and validate', () => {
    expect(parseCommand(['serve', '--seed', '42', '--now', '2026-01-01T00:00:00Z'])).toEqual({
      kind: 'serve',
      args: { noConfig: false, seed: 42, now: '2026-01-01T00:00:00Z' },
    });
    expect(parseCommand(['validate', '--seed=4294967295'])).toMatchObject({ args: { seed: 4294967295 } });
    for (const seed of ['-1', '4294967296', '1.5', 'x', '0x10']) {
      expect(parseCommand(['serve', `--seed=${seed}`])).toMatchObject({ kind: 'usage-error' });
    }
    for (const now of ['2026-01-01', 'tomorrow', '2026-01-01T00:00:00']) {
      expect(parseCommand(['serve', '--now', now])).toMatchObject({
        kind: 'usage-error',
        message: expect.stringContaining('RFC 3339') as unknown,
      });
    }
  });

  it('parses --scenario for serve and validate', () => {
    expect(parseCommand(['serve', '--scenario', 'payment-declined'])).toEqual({
      kind: 'serve',
      args: { noConfig: false, scenario: 'payment-declined' },
    });
    expect(parseCommand(['validate', '--scenario=default'])).toMatchObject({ args: { scenario: 'default' } });
    for (const scenario of ['Payment', 'a_b', '-x', '']) {
      expect(parseCommand(['serve', `--scenario=${scenario}`])).toMatchObject({ kind: 'usage-error' });
    }
  });

  it.each([
    [['--help']],
    [['-h']],
    [['help']],
    [['serve', '--help']],
    [['serve', '-h', '--port', '1']],
    [['validate', '-h']],
  ])('recognises help: %j', (argv) => {
    expect(parseCommand(argv)).toEqual({ kind: 'help' });
  });

  it.each([
    [[], 'missing command'],
    [['start'], 'unknown command "start"'],
    [['serve', '--verbose'], 'Unknown option'],
    [['serve', '--port'], 'argument missing'],
    [['serve', '--data'], 'argument missing'],
    [['serve', '--config'], 'argument missing'],
    [['serve', '--data', '--port', '1'], '--data'],
    [['serve', '--port', 'abc'], 'invalid port'],
    [['serve', '--port', '65536'], 'invalid port'],
    [['serve', '--port', '-1'], 'port'],
    [['serve', '--port', '1.5'], 'invalid port'],
    [['serve', '--host', 'not a host'], 'invalid host "not a host"'],
    [['serve', 'extra'], 'unexpected argument "extra"'],
    [['serve', '--strict'], '--strict applies only to validate'],
    [['serve', '--require-reviewed'], '--require-reviewed applies only to validate'],
    [['serve', '--format', 'json'], '--format applies only to validate'],
    [['validate', '--format', 'xml'], 'invalid format "xml"'],
  ])('rejects %j', (argv, message) => {
    const parsed = parseCommand(argv);
    expect(parsed.kind).toBe('usage-error');
    if (parsed.kind === 'usage-error') expect(parsed.message).toContain(message);
  });

  it('reports --config with --no-config as a cli-conflict startup error', () => {
    for (const command of ['serve', 'validate']) {
      const parsed = parseCommand([command, '--config', 'a.yaml', '--no-config']);
      expect(parsed).toMatchObject({
        kind: 'usage-error',
        error: { code: 'cli-conflict', source: 'cli', path: '--no-config' },
      });
    }
    expect(parseCommand(['validate', '--format', 'json', '--no-config', '--config=a.yaml'])).toMatchObject({
      format: 'json',
    });
  });
});
