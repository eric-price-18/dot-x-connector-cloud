import { extractUrlsWithIndices } from './twitter-text-vendor.mjs';
import { validatePostText } from './write-validation.mjs';
// Official public pricing verified 2026-10-02. No summoned/owned/dedup discount.
export function originalPrice(text) {
  validatePostText(text);
  // Inspect normalized shadows only; never alter the outgoing text. The URL
  // parser is supplemented for unknown TLDs, IDNs and encoded/invisible syntax.
  const shadow=text.normalize('NFKC').replace(/[\u3002\uff0e\uff61]/g,'.');
  const ambiguous=/[\p{Cf}\p{Zl}\p{Zp}]/u.test(text)
    ||/%[0-9a-f]{2}|&(?:#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/i.test(shadow)
    ||/\\|\/\/|\b(?:https?|ftp|file|data|javascript):|[a-z][a-z0-9+.-]*:\s*\//i.test(shadow)
    ||/[\p{L}\p{N}]\.+[\p{L}\p{N}]/u.test(shadow);
  return !ambiguous&&extractUrlsWithIndices(text).length===0&&extractUrlsWithIndices(shadow).length===0?15000:200000;
}
