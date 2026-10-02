import { SERVICE } from '../src/service.mjs';
import { b64url } from '../src/security.mjs';

// Ephemeral test keys only. Never stored, logged, provisioned or used in production.
export async function serviceFixture(now = 1801353600) {
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const exported=await crypto.subtle.exportKey('jwk',pair.publicKey);
  const jwk={kty:exported.kty,crv:exported.crv,x:exported.x,y:exported.y};
  const hash=async bytes=>b64url(await crypto.subtle.digest('SHA-256',bytes));
  const encoder=new TextEncoder();
  const kid=await hash(encoder.encode(JSON.stringify({crv:jwk.crv,kty:jwk.kty,x:jwk.x,y:jwk.y})));
  const env={PUBLIC_BASE_URL:new URL(SERVICE.audience).origin,SERVICE_ENABLED:'true',SERVICE_PUBLIC_JWK:JSON.stringify(jwk),
    LIVE_X_ENABLED:'false',LIVE_IDP_ENABLED:'false',OWNER_LOGIN_ENABLED:'false',READ_POLLING_ENABLED:'false',POST_ENABLED:'false',REPLY_ENABLED:'false'};
  const body=(name='x_connection_status',args={})=>JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
  async function token(raw,{claims={},header={},rawHeader,rawClaims}={}) {
    const h=rawHeader??JSON.stringify({alg:'ES256',typ:'JWT',kid,...header});
    const c=rawClaims??JSON.stringify({iss:SERVICE.issuer,sub:SERVICE.subject,aud:SERVICE.audience,scope:'x:read',iat:now,exp:now+45,
      jti:crypto.randomUUID(),method:'POST',path:SERVICE.path,body_sha256:await hash(encoder.encode(raw)),...claims});
    const encoded=`${b64url(encoder.encode(h))}.${b64url(encoder.encode(c))}`;
    const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,encoder.encode(encoded));
    return `${encoded}.${b64url(signature)}`;
  }
  async function request(raw=body(),proofOptions={},options={}) {
    const proof=options.proof??await token(raw,proofOptions);
    return new Request(options.url??SERVICE.audience,{method:options.method??'POST',headers:{
      authorization:`Bearer ${proof}`,'content-type':'application/json',accept:'application/json, text/event-stream',
      'mcp-protocol-version':'2025-11-25',...options.headers},
      ...(['GET','HEAD'].includes(options.method)?{}:{body:options.sendBody??raw})});
  }
  return {env,jwk,kid,body,token,request,now};
}
