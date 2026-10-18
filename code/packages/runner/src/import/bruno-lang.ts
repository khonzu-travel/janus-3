// @ts-expect-error -- @usebruno/lang is CommonJS and ships no types; the parts used are typed below.
import lang from '@usebruno/lang';

/**
 * The parts of `@usebruno/lang` the Bruno importer uses.
 * Each parser throws on text it cannot read.
 */
interface BrunoLang {
  /** A request `.bru` file. */
  bruToJsonV2(text: string): unknown;
  /** An `environments/*.bru` file. */
  bruToEnvJsonV2(text: string): unknown;
  /** `collection.bru` or `folder.bru`. */
  collectionBruToJson(text: string): unknown;
}

export const bruno = lang as BrunoLang;
