import { Store } from './storage.mjs';
import { periods } from './ongoing.mjs';
import { assert, positiveLimit, SafeError } from './security.mjs';

// Only the queue publisher uses this Store. Its existing prepaid envelope is
// reserved by ServiceWrites before token refresh, identity lookup or the write.
// The direct publisher and non-prepaid reservation path remain unchanged.
export class ReplyQueueStore extends Store {
  async reserveOngoingRequest(env,records,write,amount,headroom) {
    const prepaid=this.prepaidCredit;
    if(!prepaid)return super.reserveOngoingRequest(env,records,write,amount,headroom);
    this.checkCreditWindow(env);
    const now=this.clock(),{day,month}=periods(now),hour=Math.floor(now/3600);
    const specs=[
      [`requests:day:${day}`,1,positiveLimit(env,'MAX_X_REQUESTS_DAY',16,100),now+40*86400,'LOCAL_REQUESTS_DAY_EXHAUSTED'],
      [`requests:hour:${hour}`,1,positiveLimit(env,'MAX_X_REQUESTS_HOUR',8,20),(hour+1)*3600,'LOCAL_REQUESTS_HOUR_EXHAUSTED'],
      ...(records?[[`records:month:${month}`,records,positiveLimit(env,'MAX_READ_RECORDS_MONTH',1000,10000),now+40*86400,'LOCAL_RECORDS_MONTH_EXHAUSTED']]:[]),
      ...(write?[[`writes:day:${day}`,1,positiveLimit(env,'MAX_WRITES_DAY',2,11),now+40*86400,'LOCAL_WRITES_DAY_EXHAUSTED']]:[])
    ];
    assert(Number.isSafeInteger(amount)&&amount>0&&Number.isSafeInteger(records)&&records>=0,'INVALID_RESERVATION');
    assert(prepaid.remaining>=amount,'ONGOING_PREPAID_EXHAUSTED',429);
    const inputs=specs.map(()=>'(?,?,?,?)').join(','),values=specs.flatMap(row=>row.slice(0,4));
    // One SQLite statement is atomic, including every row of its UPSERT.
    // Existing NOT NULL constraints abort all buckets on cooldown/overrun;
    // neither an INSERT nor an UPDATE can skip a denied bucket or partly charge.
    const statement=this.statement(`WITH requested(bucket,n,maximum,expires) AS (VALUES ${inputs})
      INSERT INTO budgets(bucket,used,expires_at)
      SELECT bucket,CASE WHEN n<=maximum AND NOT EXISTS(SELECT 1 FROM cooldowns WHERE name='x' AND until_at>?)
        THEN n ELSE NULL END,expires FROM requested WHERE 1
      ON CONFLICT(bucket) DO UPDATE SET used=CASE
        WHEN budgets.used+excluded.used<=(SELECT maximum FROM requested WHERE bucket=excluded.bucket)
        THEN budgets.used+excluded.used ELSE NULL END
      RETURNING bucket,used`,...values,now);
    prepaid.remaining-=amount;
    try {
      const result=await statement.all();
      assert(result.success!==false&&result.results?.length===specs.length
        &&specs.every(([bucket,n,limit])=>result.results.some(row=>row.bucket===bucket
          &&Number.isSafeInteger(row.used)&&row.used>=n&&row.used<=limit)),
      'LOCAL_REQUEST_RESERVATION_REJECTED',429);
    } catch {
      prepaid.remaining+=amount;
      // Diagnostics are advisory, only after a failed reservation. They never
      // permit dispatch or undo an uncertain database result. Preserve the
      // existing precise cooldown/quota reasons without reads on success.
      const diagnostics=specs.map(()=>'(?,?,?,?,?)').join(',');
      let denied;
      try {
        denied=await this.first(`WITH requested(bucket,n,maximum,code,priority) AS (VALUES ${diagnostics})
          SELECT CASE WHEN EXISTS(SELECT 1 FROM cooldowns WHERE name='x' AND until_at>?)
            THEN 'X_RATE_LIMIT_COOLDOWN' ELSE
            (SELECT code FROM requested LEFT JOIN budgets USING(bucket)
              WHERE COALESCE(used,0)+n>maximum ORDER BY priority LIMIT 1) END AS code`,
        ...specs.flatMap(([bucket,n,limit,,code],priority)=>[bucket,n,limit,code,priority]),now);
      } catch {}
      throw new SafeError(denied?.code??'LOCAL_REQUEST_RESERVATION_REJECTED',429);
    }
    prepaid.consumed+=amount;this.creditAttempt={prepaid,amount};
  }
}
