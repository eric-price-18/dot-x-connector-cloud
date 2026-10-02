import assert from 'node:assert/strict';
import { harness, response } from './helpers.mjs';
import { signingFixture } from './jwt-fixtures.mjs';

export const getCookie = (res,name) => res.headers.getSetCookie().find(v=>v.startsWith(`${name}=`))?.split(';')[0];
export async function ownerHarness(t,overrides={}) {
  const h=harness(t,{MCP_AUTH_MODE:'descope',MCP_JWT_ALG:'RS256',MCP_CLIENT_REGISTRATION:'predefined',
    MCP_JWKS_URL:'https://identity.example.invalid/keys',MCP_USERINFO_URL:'https://identity.example.invalid/userinfo',
    OWNER_LOGIN_ENABLED:'true',OWNER_CLIENT_ID:'mock-owner-client',OWNER_CLIENT_AUTH_METHOD:'client_secret_post',
    OWNER_CLIENT_SECRET:'mock-owner-client-secret',OWNER_AUTHORIZATION_URL:'https://identity.example.invalid/authorize',
    OWNER_TOKEN_URL:'https://identity.example.invalid/token',OWNER_CALLBACK_URL:'https://connector.example.invalid/owner/callback',
    ...overrides});
  const signer=await signingFixture();
  const owner={claims:{},tokenResponse:{},userinfo:{sub:h.env.MCP_ALLOWED_SUBJECT},userinfoStatus:200,exchanges:[],onExchange:null,token:null};
  h.state.discovery={jwks_uri:h.cfg.jwks,userinfo_endpoint:h.cfg.userinfo,
    token_endpoint_auth_methods_supported:['client_secret_post','none']};
  h.state.onIdp=async(url,options)=>{
    if(url===h.cfg.jwks)return response({keys:[signer.jwk]});
    if(url===h.cfg.userinfo)return response(owner.userinfo,owner.userinfoStatus);
    if(url===h.env.OWNER_TOKEN_URL){
      owner.exchanges.push(options);
      const override=await owner.onExchange?.(options);if(override)return override;
      owner.token=await signer.sign({iss:h.cfg.issuer,aud:h.cfg.resource,exp:h.state.now+300,
        sub:h.env.MCP_ALLOWED_SUBJECT,scope:'openid x:read',token_type:'access_token',...owner.claims});
      return response({access_token:owner.token,token_type:'Bearer',expires_in:300,
        refresh_token:'mock-owner-refresh-discarded',id_token:'mock-id-token-discarded',...owner.tokenResponse});
    }
  };
  async function start(headers={}) {
    const res=await h.api('/owner/login',{method:'POST',headers:{origin:h.cfg.base,...headers}});
    assert.equal(res.status,303,await res.clone().text());
    return {res,url:new URL(res.headers.get('location')),cookie:getCookie(res,'__Host-owner-login')};
  }
  function complete(link,parameters={},headers={}) {
    const params=new URLSearchParams({state:link.url.searchParams.get('state'),code:'mock-descope-code',...parameters});
    return h.api(`/owner/callback?${params}`,{headers:{cookie:link.cookie,...headers}});
  }
  async function login() {
    const link=await start();const res=await complete(link);assert.equal(res.status,303,await res.clone().text());
    const cookie=getCookie(res,'__Host-owner-session');
    const page=await h.api('/owner',{headers:{cookie}});assert.equal(page.status,200,await page.clone().text());
    const html=await page.text();const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];assert(csrf);
    return {link,res,cookie,csrf,html};
  }
  function form(path,session,extra={},headers={}) {
    return h.api(path,{method:'POST',raw:new URLSearchParams({csrf:session.csrf,...extra}).toString(),
      headers:{origin:h.cfg.base,cookie:session.cookie,'content-type':'application/x-www-form-urlencoded',...headers}});
  }
  return {...h,owner,start,complete,login,form};
}
