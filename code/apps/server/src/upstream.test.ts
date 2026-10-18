import { describe, expect, it } from 'vitest';

import { classifyUpstreamError } from './upstream.js';

const failure = (message: string, code?: string, cause?: unknown): Error =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), code === undefined ? {} : { code });

describe('classifyUpstreamError', () => {
  it.each([
    ['ECONNREFUSED', 'refused'],
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['EHOSTUNREACH', 'unreachable'],
    ['UND_ERR_CONNECT_TIMEOUT', 'connect-timeout'],
    ['ECONNRESET', 'reset'],
    ['UND_ERR_SOCKET', 'reset'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificate'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'certificate'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certificate'],
    ['CERT_HAS_EXPIRED', 'certificate'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'certificate'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls'],
    ['HPE_INVALID_CONSTANT', 'invalid-response'],
    ['UND_ERR_INVALID_ARG', 'invalid-request'],
    ['ERR_SOMETHING_NEW', 'unknown'],
  ])('maps %s to %s', (code, reason) => {
    expect(classifyUpstreamError(failure(`failed: ${code}`, code))).toEqual({
      reason,
      code,
      text: `failed: ${code}`,
    });
  });

  it('finds the code on a cause and joins every message', () => {
    const error = failure('fetch failed', undefined, failure('connect ECONNREFUSED 127.0.0.1:9', 'ECONNREFUSED'));
    expect(classifyUpstreamError(error)).toEqual({
      reason: 'refused',
      code: 'ECONNREFUSED',
      text: 'fetch failed <- connect ECONNREFUSED 127.0.0.1:9',
    });
  });

  it("reads an AggregateError's errors, one per address tried", () => {
    const error = new AggregateError([failure('connect ECONNREFUSED ::1:9', 'ECONNREFUSED')], '');
    expect(classifyUpstreamError(error)).toMatchObject({ reason: 'refused', code: 'ECONNREFUSED' });
  });

  it('reports what it cannot classify as unknown and survives a cause cycle', () => {
    const error = failure('odd');
    (error as { cause?: unknown }).cause = error;
    expect(classifyUpstreamError(error)).toEqual({ reason: 'unknown', code: undefined, text: 'odd' });
    expect(classifyUpstreamError('text')).toEqual({ reason: 'unknown', code: undefined, text: 'text' });
  });
});
