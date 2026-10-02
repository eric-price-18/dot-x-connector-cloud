// Test-only synthetic recipient, exact payload and historical deadline.
import { CREDIT_RUN_DEADLINE } from '../src/credit-policy.mjs';
import { createHash } from 'node:crypto';
import { key } from './write-fixtures.mjs';
export const canaryText='@fixture_friend A single approved test message. 🌬️';
export const canaryArgs=(text=canaryText,n=80)=>({text,idempotency_key:key(n)});
export const canaryConfig=(text=canaryText,n=80,handle='@fixture_friend')=>({
 X_CANARY_MENTION_HANDLE:handle,X_CANARY_MENTION_IDEMPOTENCY_KEY:key(n),
 X_CANARY_MENTION_TEXT_SHA256:createHash('sha256').update(text).digest('hex'),
 X_CANARY_MENTION_EXPIRES_AT:String(CREDIT_RUN_DEADLINE)
});
