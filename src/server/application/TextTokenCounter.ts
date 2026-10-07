import { Tiktoken } from 'js-tiktoken/lite';
import o200kRanks from 'js-tiktoken/ranks/o200k_base';

let encoding: Tiktoken | null = null;

/** Share one lazily constructed tokenizer across material selection and practice checks.
 * Importing API routes must not allocate the 200,000-entry lookup maps. Only the
 * supported o200k encoding is loaded; provider/image overhead remains separate. */
export function countTextTokens(
  text: string,
  options: { allowSpecialTokenText?: boolean } = {},
): number {
  encoding ??= new Tiktoken(o200kRanks);
  return encoding.encode(text, [], options.allowSpecialTokenText ? [] : 'all').length;
}
