import { ongoing, reserveOngoing, ongoingReservationStatement, periods } from './ongoing.mjs';
import { assert, positiveLimit, randomValue, SafeError } from './security.mjs';
import { CREDIT_RUN_ID,CREDIT_RUN_DEADLINE,CREDIT_MAX_MICROUSD } from './credit-policy.mjs';

export class Store {
  constructor(db, clock) {
    assert(db?.prepare && db?.batch, 'D1_BINDING_REQUIRED', 503);
    // No Sessions API: D1 sends all queries to its primary, without read replicas.
    this.db = db;
    this.clock = clock;
  }
  statement(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  first(sql, ...args) { return this.statement(sql, ...args).first(); }
  run(sql, ...args) { return this.statement(sql, ...args).run(); }

  account() { return this.first("SELECT * FROM accounts WHERE id = 'primary'"); }

  async saveAccount(issuer, subject, userId, encrypted, expires, expectedVersion = null) {
    const row = await this.first(`INSERT INTO accounts
      (id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at)
      SELECT 'primary',?,?,?,?,?,?
      WHERE ? IS NULL OR ?=0 OR EXISTS(SELECT 1 FROM accounts WHERE id='primary')
      ON CONFLICT(id) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens,
      expires_at=excluded.expires_at, version=accounts.version+1,
      refresh_status='idle', refresh_attempt=NULL, updated_at=excluded.updated_at
      WHERE accounts.issuer=excluded.issuer AND accounts.subject=excluded.subject
      AND accounts.x_user_id=excluded.x_user_id
      AND (? IS NULL OR accounts.version=?) RETURNING id`,
    issuer, subject, userId, encrypted, expires, this.clock(), expectedVersion, expectedVersion, expectedVersion, expectedVersion);
    assert(row, 'ACCOUNT_BINDING_MISMATCH', 403);
  }

  async claimRefresh(version) {
    const attempt = randomValue();
    const row = await this.first(`UPDATE accounts SET refresh_status='inflight',refresh_attempt=?
      WHERE id='primary' AND version=? AND refresh_status='idle' RETURNING id`, attempt, version);
    assert(row, 'REFRESH_IN_PROGRESS_OR_RECONNECT_REQUIRED', 409);
    return attempt;
  }

  async finishRefresh(version, attempt, encrypted, expires) {
    const row = await this.first(`UPDATE accounts SET encrypted_tokens=?,expires_at=?,
      version=version+1,refresh_status='idle',refresh_attempt=NULL,updated_at=?
      WHERE id='primary' AND version=? AND refresh_attempt=? AND refresh_status='inflight' RETURNING id`,
    encrypted, expires, this.clock(), version, attempt);
    assert(row, 'REFRESH_SUPERSEDED_RECONNECT_REQUIRED', 409);
  }

  async failRefresh(version, attempt) {
    await this.run(`UPDATE accounts SET refresh_status='reconnect' WHERE id='primary'
      AND version=? AND refresh_attempt=?`, version, attempt);
  }

  async consumeState(hash, cookieHash) {
    const row = await this.first(`DELETE FROM oauth_states
      WHERE state_hash=? AND cookie_hash=? AND expires_at>? RETURNING encrypted_payload`,
    hash, cookieHash, this.clock());
    assert(row, 'OAUTH_STATE_INVALID_OR_EXPIRED', 400);
    return row.encrypted_payload;
  }

  async reserve(bucket, amount, limit, expires, detailed = false) {
    const row = await this.first(`INSERT INTO budgets (bucket,used,expires_at)
      SELECT ?,?,? WHERE ?<=?
      ON CONFLICT(bucket) DO UPDATE SET used=budgets.used+excluded.used
      WHERE budgets.used+excluded.used<=? RETURNING used`, bucket, amount, expires, amount, limit, limit);
    assert(row, !detailed ? 'LOCAL_BUDGET_EXHAUSTED' : bucket.startsWith('requests:day:') ? 'LOCAL_REQUESTS_DAY_EXHAUSTED'
      : bucket.startsWith('requests:hour:') ? 'LOCAL_REQUESTS_HOUR_EXHAUSTED'
      : bucket.startsWith('records:month:') ? 'LOCAL_RECORDS_MONTH_EXHAUSTED'
      : bucket.startsWith('writes:day:') ? 'LOCAL_WRITES_DAY_EXHAUSTED' : 'LOCAL_BUDGET_EXHAUSTED', 429);
  }

  checkCreditWindow(env) {
    if(ongoing(env)) {
      const day=periods(this.clock()).day;
      assert((!this.operationDay||this.operationDay===day) && periods(this.clock()+90).day===day && (!this.ongoingReservationDay||this.ongoingReservationDay===day),'ONGOING_CALENDAR_BOUNDARY_PAUSE',429);
      assert(!this.ongoingCycleEnd||this.clock()+90<this.ongoingCycleEnd,'ONGOING_PROVIDER_BOUNDARY_PAUSE',429);
      return;
    }
    const expires=Number(env.X_CREDIT_EXPIRES_AT);
    assert(env.X_CREDIT_BUDGET_ID===CREDIT_RUN_ID && Number.isSafeInteger(expires)
      && expires<=CREDIT_RUN_DEADLINE && expires>this.clock(),'X_CREDIT_AUTHORIZATION_REQUIRED',503);
  }

  async reserveCredit(env,amount,headroom=0) {
    if(ongoing(env)) {
      this.checkCreditWindow(env);
      if(this.prepaidCredit!==undefined) {
        assert(this.prepaidCredit.remaining>=amount,'ONGOING_PREPAID_EXHAUSTED',429);
        this.prepaidCredit.remaining-=amount;this.prepaidCredit.consumed+=amount;
        this.creditAttempt={prepaid:this.prepaidCredit,amount};return;
      }
      const day=periods(this.clock()).day;
      const result=await reserveOngoing(this,env,amount,headroom);
      this.ongoingReservationDay=day;this.creditAttempt={id:result,amount};return result;
    }
    this.checkCreditWindow(env);
    const id=env.X_CREDIT_BUDGET_ID,account=env.X_EXPECTED_USER_ID;
    const cap=Number(env.X_CREDIT_CAP_MICROUSD),expires=Number(env.X_CREDIT_EXPIRES_AT);
    const initial=typeof env.X_CREDIT_INITIAL_MICROUSD==='string'&&env.X_CREDIT_INITIAL_MICROUSD.trim()!==''?Number(env.X_CREDIT_INITIAL_MICROUSD):NaN;
    assert(typeof id==='string' && /^[A-Za-z0-9_-]{8,64}$/.test(id) && /^[1-9][0-9]{0,18}$/.test(account??'')
      && Number.isSafeInteger(cap) && cap>0 && cap<=CREDIT_MAX_MICROUSD && Number.isSafeInteger(expires) && expires>this.clock()
      && Number.isSafeInteger(initial) && initial>=0 && initial<=cap && Number.isSafeInteger(amount) && amount>0,
      'X_CREDIT_AUTHORIZATION_REQUIRED',503);
    // Pin the authorization even when its first requested charge cannot fit.
    // A denied first attempt cannot later lower INITIAL or change cap/expiry.
    await this.run(`INSERT INTO x_credit_budgets
      (budget_id,account_id,cap_micro_usd,initial_micro_usd,used_micro_usd,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,id,account,cap,initial,initial,expires,this.clock());
    const row=await this.first(`UPDATE x_credit_budgets SET used_micro_usd=used_micro_usd+?
      WHERE budget_id=? AND account_id=? AND cap_micro_usd=? AND initial_micro_usd=? AND expires_at=?
        AND expires_at>? AND used_micro_usd+?<=cap_micro_usd RETURNING used_micro_usd`,
      amount,id,account,cap,initial,expires,this.clock(),amount);
    assert(row,'X_CREDIT_CAP_REACHED_OR_CHANGED',429);
  }

  async resolveCredit(attempt=this.creditAttempt) {
    if(!attempt)return;
    if(attempt.prepaid){attempt.prepaid.resolved+=attempt.amount;return;}
    try {await this.run("UPDATE ongoing_spend SET unresolved_micro_usd=0 WHERE id=?",attempt.id);} catch {}
  }

  markCreditDispatched(attempt=this.creditAttempt) {if(attempt)attempt.dispatched=true;}

  async releaseUnattemptedCredit(attempt=this.creditAttempt) {
    // Only this invocation's ephemeral, never-dispatched attempt is eligible.
    // No lookup by user-supplied ID and no historic/billing-based reconciliation.
    if(!attempt||attempt.dispatched||attempt.released)return;
    if(attempt.prepaid){attempt.prepaid.remaining+=attempt.amount;attempt.prepaid.consumed-=attempt.amount;}
    else await this.run("UPDATE ongoing_spend SET amount=0,unresolved_micro_usd=0 WHERE id=? AND kind='api' AND amount=?",attempt.id,attempt.amount);
    attempt.released=true;
  }

  async reserveOngoingRequest(env,records,write,amount,headroom) {
    this.checkCreditWindow(env);
    const now=this.clock(),{day,month}=periods(now),hour=Math.floor(now/3600);
    const specs=[
      [`requests:day:${day}`,1,positiveLimit(env,'MAX_X_REQUESTS_DAY',16,100),now+40*86400,'LOCAL_REQUESTS_DAY_EXHAUSTED'],
      [`requests:hour:${hour}`,1,positiveLimit(env,'MAX_X_REQUESTS_HOUR',8,20),(hour+1)*3600,'LOCAL_REQUESTS_HOUR_EXHAUSTED'],
      ...(records?[[`records:month:${month}`,records,positiveLimit(env,'MAX_READ_RECORDS_MONTH',1000,10000),now+40*86400,'LOCAL_RECORDS_MONTH_EXHAUSTED']]:[]),
      ...(write?[[`writes:day:${day}`,1,positiveLimit(env,'MAX_WRITES_DAY',2,11),now+40*86400,'LOCAL_WRITES_DAY_EXHAUSTED']]:[])
    ];
    assert(Number.isSafeInteger(amount)&&amount>0&&Number.isSafeInteger(records)&&records>=0,'INVALID_RESERVATION');
    const prepaid=this.prepaidCredit;
    if(prepaid)assert(prepaid.remaining>=amount,'ONGOING_PREPAID_EXHAUSTED',429);
    // Read checks provide precise diagnostics; the batch repeats all checks
    // atomically so concurrent callers cannot bypass quotas or partially charge.
    const cooldown=await this.first("SELECT until_at FROM cooldowns WHERE name='x'");
    assert(!cooldown||cooldown.until_at<=now,'X_RATE_LIMIT_COOLDOWN',429);
    for(const [bucket,n,limit,,code] of specs){
      const row=await this.first('SELECT used FROM budgets WHERE bucket=?',bucket);
      assert((row?.used??0)+n<=limit,code,429);
    }
    const statements=[this.statement("SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM cooldowns WHERE name='x' AND until_at>?) THEN 'null' ELSE 'denied' END)",now)];
    for(const [bucket,n,limit,expires] of specs)statements.push(this.statement(`INSERT INTO budgets(bucket,used,expires_at)
      VALUES(?,CASE WHEN ?<=? THEN ? ELSE NULL END,?) ON CONFLICT(bucket) DO UPDATE SET
      used=CASE WHEN budgets.used+excluded.used<=? THEN budgets.used+excluded.used ELSE NULL END`,bucket,n,limit,n,expires,limit));
    const spendIndex=statements.length;
    if(!prepaid){
      statements.push(ongoingReservationStatement(this,env,amount,headroom));
      // A zero-row conditional spend insertion must abort the whole D1 batch.
      statements.push(this.statement("SELECT json(CASE WHEN changes()=1 THEN 'null' ELSE 'denied' END)"));
    }
    if(prepaid){assert(prepaid.remaining>=amount,'ONGOING_PREPAID_EXHAUSTED',429);prepaid.remaining-=amount;}
    let results;
    try {results=await this.db.batch(statements);assert(results.length===statements.length&&results.every(r=>r.success!==false),'LOCAL_REQUEST_RESERVATION_REJECTED',429);} catch(error) {
      if(prepaid)prepaid.remaining+=amount;
      // D1 batch is transactional. Failed execution rolls back every statement;
      // uncertain DB responses never justify a refund or any provider dispatch.
      throw new SafeError('LOCAL_REQUEST_RESERVATION_REJECTED',429);
    }
    if(prepaid){prepaid.consumed+=amount;this.creditAttempt={prepaid,amount};}
    else {
      const row=results[spendIndex]?.results?.[0];
      assert(row&&Number.isSafeInteger(row.id),'ONGOING_RESERVATION_RESULT_UNCERTAIN',503);
      this.ongoingCycleEnd=row.cycle_end;this.ongoingReservationDay=day;this.creditAttempt={id:row.id,amount};
    }
  }

  async reserveX(env, records = 0, write = false, creditMicroUsd = undefined, headroom=0) {
    if(ongoing(env))return this.reserveOngoingRequest(env,records,write,creditMicroUsd??(write?200000:records?records*5000:10000),headroom);
    // Worst-case posted prices, no ownership discount or dedup assumption. All
    // mutations reserve $0.20 (including URL posts); unclassified auth/user reads
    // reserve $0.01. Expanded reads pass an explicit conservative bound.
    await this.reserveCredit(env,creditMicroUsd ?? (write?200000:records?records*5000:10000),headroom);
    const now = this.clock();
    const cooldown = await this.first("SELECT until_at FROM cooldowns WHERE name='x'");
    assert(!cooldown || cooldown.until_at <= now, 'X_RATE_LIMIT_COOLDOWN', 429);
    const day = ongoing(env)?periods(now).day:Math.floor(now / 86400);
    const hour = Math.floor(now / 3600);
    const date = new Date(now * 1000);
    const month = ongoing(env)?periods(now).month:`${date.getUTCFullYear()}-${date.getUTCMonth()+1}`;
    const monthEnd = ongoing(env)?now+40*86400:Date.UTC(date.getUTCFullYear(), date.getUTCMonth()+1, 1) / 1000;
    // Reservations are deliberately pessimistic and never refunded after failure.
    await this.reserve(`requests:day:${day}`, 1, positiveLimit(env,'MAX_X_REQUESTS_DAY',16,100), (ongoing(env)?now+40*86400:(day+1)*86400), ongoing(env));
    await this.reserve(`requests:hour:${hour}`, 1, positiveLimit(env,'MAX_X_REQUESTS_HOUR',8,20), (hour+1)*3600, ongoing(env));
    if (records) await this.reserve(`records:month:${month}`, records,
      positiveLimit(env,'MAX_READ_RECORDS_MONTH',1000,10000), monthEnd, ongoing(env));
    if (write) await this.reserve(`writes:day:${day}`, 1,
      positiveLimit(env,'MAX_WRITES_DAY',2,ongoing(env)?11:10), (ongoing(env)?now+40*86400:(day+1)*86400), ongoing(env));
  }

  async setCooldown(until) {
    await this.run(`INSERT INTO cooldowns(name,until_at) VALUES('x',?)
      ON CONFLICT(name) DO UPDATE SET until_at=MAX(cooldowns.until_at,excluded.until_at)`, until);
  }

  async reserveSend(keyHash, payloadHash) {
    const row = await this.first(`INSERT INTO sends(idempotency_hash,payload_hash,status,created_at)
      VALUES(?,?,'pending',?) ON CONFLICT DO NOTHING RETURNING idempotency_hash`,
    keyHash, payloadHash, this.clock());
    if (row) return null;
    const byKey = await this.first('SELECT * FROM sends WHERE idempotency_hash=?', keyHash);
    assert(!byKey || byKey.payload_hash === payloadHash, 'IDEMPOTENCY_KEY_REUSED', 409);
    const prior = byKey ?? await this.first('SELECT * FROM sends WHERE payload_hash=?', payloadHash);
    assert(prior?.payload_hash === payloadHash, 'IDEMPOTENCY_KEY_REUSED', 409);
    assert(byKey, 'DUPLICATE_CONTENT_DO_NOT_RESEND', 409);
    if (prior.status === 'sent') return { id: prior.result_id, duplicate: true };
    throw new SafeError('SEND_PENDING_OR_UNCERTAIN_DO_NOT_RETRY', 409);
  }

  async cleanup() {
    await this.db.batch([
      this.statement('DELETE FROM oauth_states WHERE expires_at<=?', this.clock()),
      this.statement('DELETE FROM budgets WHERE expires_at<=?', this.clock()),
      this.statement('DELETE FROM snapshots WHERE fetched_at<=?', this.clock()-7*86400)
    ]);
  }
}
