// TEST ONLY. Miniflare substitutes this module in memory under a mock-only
// outbound service. Production code has no fixture hook and remains expired.
import { RUNTIME_NOW } from './clock-fixture.mjs';
export const CREDIT_RUN_ID='offline-test-credit-budget';
export const CREDIT_RUN_DEADLINE=RUNTIME_NOW+86400;
export const CREDIT_MAX_MICROUSD=5000000;
export const creditModuleSource=`export const CREDIT_RUN_ID=${JSON.stringify(CREDIT_RUN_ID)};\nexport const CREDIT_RUN_DEADLINE=${CREDIT_RUN_DEADLINE};\nexport const CREDIT_MAX_MICROUSD=${CREDIT_MAX_MICROUSD};\n`;
