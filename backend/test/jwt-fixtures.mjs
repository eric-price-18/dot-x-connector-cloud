// Ephemeral mock-only signing keys generated locally; nothing is provisioned.
const pairs = new Map();
export async function signingFixture(alg = 'RS256', kid = 'mock-signing-key') {
  const cacheKey = `${alg}:${kid}`;
  if (!pairs.has(cacheKey)) pairs.set(cacheKey, crypto.subtle.generateKey(alg === 'RS256'
    ? { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }
    : { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']));
  const pair = await pairs.get(cacheKey);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), alg, kid, use: 'sig' };
  async function sign(claims, header = {}) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ typ: 'JWT', alg, kid, ...header })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign(alg === 'RS256' ? 'RSASSA-PKCS1-v1_5'
      : { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(signature).toString('base64url')}`;
  }
  return { jwk, sign };
}
