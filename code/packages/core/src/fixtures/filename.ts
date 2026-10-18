import { isLanguageTag } from '../http/language.js';
import { decodeMediaTypeToken, mediaTypeForExtension } from '../http/media-type.js';
import type { StartupErrorCode } from '../types/index.js';
import { isBodylessStatus } from './status.js';

export type ParsedFileName =
  | {
      readonly kind: 'response';
      readonly status: number;
      /** Decoded media type, or null for a bodyless response. */
      readonly mediaType: string | null;
      /** Lower-cased extension without the dot, or null for a bodyless response. */
      readonly extension: string | null;
      /** Language tag exactly as written between `[` `]`, or null for a language-neutral response. */
      readonly locale: string | null;
      /** The variant name, or null for a plain response. */
      readonly variant: string | null;
    }
  | { readonly kind: 'headers'; readonly status: number; readonly variant: string | null }
  | { readonly kind: 'invalid'; readonly code: StartupErrorCode; readonly message: string };

const BODY_RESPONSE = /^(\d{3})_(?:\[([^[\]]*)\]_)?\{([^{}]*)\}(.*)$/;
const SHORT_RESPONSE = /^(\d{3})(?:_\[([^[\]]*)\])?\.([^.]+)(?:\.([^.]+))?$/;
const BODYLESS_RESPONSE = /^(\d{3})(?:\.([^.]+))?$/;
const LOCALIZED_SIDECAR = /^(\d{3})_\[[^[\]]*\](?:\.[^.]+)?\.headers\.json$/;
const LOCALIZED_WITHOUT_MEDIA_TYPE = /^(\d{3})_\[[^[\]]*\](.*)$/;
const HEADER_SIDECAR = /^(\d{3})(?:\.([^.]+))?\.headers\.json$/;
const STATUS_WITH_SUFFIX = /^(\d{3})\..*$/;
const BODY_SUFFIX = /^(?:\.([^.]+))?\.([^.]+)$/;
const EXTENSION = /^[A-Za-z0-9]+$/;

/** A variant name: lowercase words of letters and digits joined by "-". */
const VARIANT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_VARIANT_BYTES = 32;
/** Names that would make a file name readable two ways; every short-form extension is reserved too. */
const RESERVED_VARIANTS: ReadonlySet<string> = new Set(['headers', 'meta']);

const GRAMMAR =
  'expected <status>.<ext> (e.g. 200.json), <status>_[<locale>].<ext> (e.g. 200_[en-US].json), <status>_{<type>-<subtype>}.<ext> (e.g. 200_{application-problem+json}.json), <status>_[<locale>]_{<type>-<subtype>}.<ext>, any of these with a variant name before the extension (e.g. 200.empty.json), a bare bodyless status (204, 205, 304) or one with a variant (304.fresh), or <status>[.<variant>].headers.json';

const VARIANT_RULE = `a variant name is lowercase letters and digits in words joined by "-", at most ${String(MAX_VARIANT_BYTES)} bytes, and not "headers", "meta" or a file extension such as json`;

/** True for a name that may follow a status as a variant. */
export function isVariantName(name: string): boolean {
  return (
    VARIANT_NAME.test(name) &&
    name.length <= MAX_VARIANT_BYTES &&
    !RESERVED_VARIANTS.has(name) &&
    mediaTypeForExtension(name) === null
  );
}

/**
 * Parses a file name inside a method directory:
 * the short form takes its media type from the extension, and every form may
 * carry a variant name just before the extension.
 */
export function parseFileName(name: string): ParsedFileName {
  const sidecar = HEADER_SIDECAR.exec(name);
  if (sidecar) {
    const status = parseStatus(sidecar[1] ?? '');
    if (typeof status !== 'number') return status;
    const variant = sidecar[2] ?? null;
    if (variant !== null && !isVariantName(variant)) return invalidVariant(variant);
    return { kind: 'headers', status, variant };
  }

  const bodyless = BODYLESS_RESPONSE.exec(name);
  if (bodyless) {
    const status = parseStatus(bodyless[1] ?? '');
    if (typeof status !== 'number') return status;
    const variant = bodyless[2] ?? null;
    if (!isBodylessStatus(status)) {
      if (variant === null) {
        return invalid(
          'invalid-filename',
          `status ${String(status)} carries a body, so the file needs an extension or a media type, e.g. ${String(status)}.json`,
        );
      }
    } else if (variant === null) {
      return response(status, null, null, null, null);
    } else if (isVariantName(variant)) {
      return response(status, null, null, null, variant);
    } else if (looksLikeExtension(variant)) {
      return invalid(
        'invalid-bodyless',
        `status ${String(status)} is bodyless; name the file exactly "${String(status)}", or "${String(status)}.<variant>"`,
      );
    } else {
      return invalidVariant(variant);
    }
  }

  const body = BODY_RESPONSE.exec(name);
  if (body) {
    const status = parseStatus(body[1] ?? '');
    if (typeof status !== 'number') return status;
    if (isBodylessStatus(status)) {
      return invalid(
        'invalid-bodyless',
        `status ${String(status)} is bodyless; name the file exactly "${String(status)}"`,
      );
    }
    const locale = body[2] ?? null;
    if (locale !== null && !isLanguageTag(locale)) return invalidLocale(locale);
    const token = body[3] ?? '';
    const mediaType = decodeMediaTypeToken(token);
    if (mediaType === null && token.includes('*')) {
      return invalid(
        'invalid-filename',
        `"{${token}}" cannot be a wildcard; name the media type the file holds, e.g. {application-json}`,
      );
    }
    if (mediaType === null) {
      return invalid(
        'invalid-filename',
        `"{${token}}" is not a media type token; write the type and subtype joined by "-", e.g. {application-json}`,
      );
    }
    const suffix = body[4] ?? '';
    if (suffix === '') return invalid('invalid-filename', `missing file extension; ${GRAMMAR}`);
    const parts = BODY_SUFFIX.exec(suffix);
    const extension = parts?.[2];
    if (parts === null || extension === undefined || !EXTENSION.test(extension)) {
      return invalid(
        'invalid-filename',
        `unsupported suffix "${suffix}": write an optional variant name and a single extension, e.g. .empty.json`,
      );
    }
    const variant = parts[1] ?? null;
    if (variant !== null && !isVariantName(variant)) return invalidVariant(variant);
    return response(status, mediaType, extension.toLowerCase(), locale, variant);
  }

  const localizedSidecar = LOCALIZED_SIDECAR.exec(name);
  if (localizedSidecar) {
    const status = localizedSidecar[1] ?? '';
    return invalid(
      'invalid-filename',
      `per-locale header sidecars are not supported; ${status}.headers.json applies to every locale of status ${status}`,
    );
  }

  const short = SHORT_RESPONSE.exec(name);
  if (short) {
    const status = parseStatus(short[1] ?? '');
    if (typeof status !== 'number') return status;
    const variant = short[4] === undefined ? null : (short[3] ?? '');
    const written = short[4] ?? short[3] ?? '';
    if (EXTENSION.test(written)) {
      if (isBodylessStatus(status)) {
        return invalid(
          'invalid-bodyless',
          `status ${String(status)} is bodyless; name the file exactly "${String(status)}"`,
        );
      }
      const locale = short[2] ?? null;
      if (locale !== null && !isLanguageTag(locale)) return invalidLocale(locale);
      if (variant !== null && !isVariantName(variant)) return invalidVariant(variant);
      const extension = written.toLowerCase();
      const mediaType = mediaTypeForExtension(extension);
      if (mediaType === null) {
        return invalid(
          'invalid-filename',
          `".${extension}" does not name a media type; write it in the name, e.g. ${String(status)}_{application-octet-stream}.${extension}`,
        );
      }
      return response(status, mediaType, extension, locale, variant);
    }
  }

  const localized = LOCALIZED_WITHOUT_MEDIA_TYPE.exec(name);
  if (localized) {
    const status = Number(localized[1]);
    if (isBodylessStatus(status)) {
      return invalid(
        'invalid-bodyless',
        `status ${String(status)} is bodyless, so it cannot have a locale; name the file exactly "${String(status)}"`,
      );
    }
    return invalid(
      'invalid-filename',
      `a localized response needs an extension or a media type after the locale, e.g. ${String(status)}_[en-US].json`,
    );
  }

  const withSuffix = STATUS_WITH_SUFFIX.exec(name);
  if (withSuffix) {
    const status = Number(withSuffix[1]);
    if (isBodylessStatus(status)) {
      return invalid(
        'invalid-bodyless',
        `status ${String(status)} is bodyless; name the file exactly "${String(status)}"`,
      );
    }
  }

  return invalid('invalid-filename', `unrecognised file name; ${GRAMMAR}`);
}

function response(
  status: number,
  mediaType: string | null,
  extension: string | null,
  locale: string | null,
  variant: string | null,
): ParsedFileName {
  return { kind: 'response', status, mediaType, extension, locale, variant };
}

/** A suffix that reads as a file extension rather than a variant name. */
function looksLikeExtension(token: string): boolean {
  return mediaTypeForExtension(token) !== null;
}

function parseStatus(digits: string): number | ParsedFileName {
  const status = Number(digits);
  if (status < 100 || status > 599) {
    return invalid('invalid-filename', `status ${digits} is outside 100–599`);
  }
  if (status < 200) {
    return invalid('invalid-filename', `status ${digits} is informational and cannot be a final fixture response`);
  }
  return status;
}

function invalidVariant(variant: string): ParsedFileName {
  return invalid('invalid-filename', `"${variant}" is not a variant name; ${VARIANT_RULE}`);
}

function invalidLocale(locale: string): ParsedFileName {
  return invalid(
    'invalid-filename',
    `"[${locale}]" is not a language tag; write a BCP 47 tag such as [en], [en-US], or [zh-Hant-TW]`,
  );
}

function invalid(code: StartupErrorCode, message: string): ParsedFileName {
  return { kind: 'invalid', code, message };
}
