import { Tiktoken } from 'js-tiktoken/lite';
import o200kRanks from 'js-tiktoken/ranks/o200k_base';

let encoding: Tiktoken | null = null;

/** Shared, lazy text-token comparison proxy; images and provider billing are not measured. */
export function countModelTextTokens(text: string): number {
  encoding ??= new Tiktoken(o200kRanks);
  return encoding.encode(text, [], []).length;
}
