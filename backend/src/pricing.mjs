import { extractUrlsWithIndices } from './twitter-text-vendor.mjs';
import { validatePostText } from './write-validation.mjs';
// Official public pricing verified 2026-10-02. No summoned/owned/dedup discount.
export function originalPrice(text) {
  validatePostText(text);
  // Cheap classification is deliberately restricted to ASCII letters, digits,
  // spaces and selected punctuation. Periods must end a sentence/token;
  // internal dots, URL syntax, encodings and non-ASCII retain the full price.
  return /^[A-Za-z0-9 .,!?;'"()\n-]+$/.test(text)&&!/\.(?!\s|$)/.test(text)&&extractUrlsWithIndices(text).length===0?15000:200000;
}
