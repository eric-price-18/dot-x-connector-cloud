// Test-only D1 transport fault. Runs the real Worker and real local D1, but drops
// the successful acknowledgment of the first committed canary slot insert.
// Never used by any Wrangler deployment profile.
import worker from './clock-worker.mjs';
let dropped=false;
function wrapStatement(statement,sql,dropAck) {
  return {
    bind(...args){return wrapStatement(statement.bind(...args),sql,dropAck);},
    async first(...args){
      const value=await statement.first(...args);
      if(dropAck&&!dropped&&sql.startsWith('INSERT INTO canary_mention')&&value){dropped=true;throw Error('injected post-commit acknowledgment loss');}
      return value;
    },
    run(...args){return statement.run(...args);},
    all(...args){return statement.all(...args);},
    raw(...args){return statement.raw(...args);},
    _statement:statement
  };
}
export default {fetch(request,env,ctx){
  if(env.TEST_FAULT_CANARY_CONFIG==='true'&&request.headers.has('x-test-canary-key'))
    env={...env,X_CANARY_MENTION_IDEMPOTENCY_KEY:request.headers.get('x-test-canary-key')};
  const DB={prepare:sql=>wrapStatement(env.DB.prepare(sql),sql,env.TEST_FAULT_CANARY_ACK==='true'),
    batch:statements=>env.DB.batch(statements.map(v=>v._statement??v))};
  return worker.fetch(request,{...env,DB},ctx);
}};
