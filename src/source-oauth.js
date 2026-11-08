import { getDataSource, setDataSourceAuthStatus, sourceDefinition } from './data-sources.js';
import { authorizeDataSource } from './authorization-manager.js';

const GOOGLE_AUTH_URL='https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL='https://oauth2.googleapis.com/token';
const PREFIX='source-oauth:transaction:v1:';
const TTL_SECONDS=600;
function randomString() {
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function challenge(verifier) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function redirectUri(requestUrl) {
  return new URL('/source-oauth/callback',requestUrl).href;
}
export async function beginSourceOAuth({env,ownerUserId,sourceId,baseUrl}) {
  const source=await getDataSource(env.MCP_DB,ownerUserId,sourceId);
  const definition=sourceDefinition(source.sourceType);
  if(source.provider!=='google'||definition.authKind!=='oauth')
    throw new Error('Source does not support Google OAuth.');
  const state=randomString(),verifier=randomString();
  await env.MCP_DB.prepare(`INSERT INTO source_oauth_states(state,owner_user_id,source_id,expires_at)
    VALUES(?,?,?,?)`).bind(state,ownerUserId,sourceId,
      Math.floor(Date.now()/1000)+TTL_SECONDS).run();
  try {
    await env.OAUTH_KV.put(PREFIX+state,JSON.stringify({verifier}),{expirationTtl:TTL_SECONDS});
  } catch(error) {
    await env.MCP_DB.prepare('DELETE FROM source_oauth_states WHERE state=?').bind(state).run();
    throw error;
  }
  const url=new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id',env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri',redirectUri(baseUrl));
  url.searchParams.set('response_type','code');
  url.searchParams.set('state',state);
  url.searchParams.set('scope',['openid','email',...definition.scopes].join(' '));
  url.searchParams.set('access_type','offline');
  url.searchParams.set('prompt','consent');
  url.searchParams.set('code_challenge_method','S256');
  url.searchParams.set('code_challenge',await challenge(verifier));
  if(source.authStatus!=='connected')await setDataSourceAuthStatus(env.MCP_DB,ownerUserId,sourceId,'pending');
  return {sourceId,authorizationUrl:url.toString(),expiresIn:TTL_SECONDS};
}
export async function completeSourceOAuth(request,env,{requestToken=fetch,requestIdentity=fetch}={}) {
  const url=new URL(request.url),state=url.searchParams.get('state');
  if(!state||!/^[-_A-Za-z0-9]{40,64}$/.test(state))throw new Error('Invalid authorization state.');
  // Atomic, one-time claim: concurrent callbacks must not exchange the same code.
  const claim=await env.MCP_DB.prepare(`UPDATE source_oauth_states SET consumed=1
    WHERE state=? AND consumed=0 AND expires_at>?`)
    .bind(state,Math.floor(Date.now()/1000)).run();
  if((claim.meta?.changes??0)!==1)throw new Error('Authorization state expired or already used.');
  const row=await env.MCP_DB.prepare(`SELECT owner_user_id AS ownerUserId,source_id AS sourceId
    FROM source_oauth_states WHERE state=?`).bind(state).first();
  const pending=await env.OAUTH_KV.get(PREFIX+state,'json');
  await env.OAUTH_KV.delete(PREFIX+state);
  if(!pending||typeof pending.verifier!=='string')throw new Error('Authorization transaction expired.');
  if(url.searchParams.has('error'))throw new Error('Provider authorization was denied.');
  const code=url.searchParams.get('code');
  if(!code)throw new Error('Provider authorization code is missing.');
  const source=await getDataSource(env.MCP_DB,row.ownerUserId,row.sourceId);
  const def=sourceDefinition(source.sourceType);
  if(source.provider!=='google'||def.authKind!=='oauth')throw new Error('Unexpected OAuth provider.');
  const response=await requestToken(GOOGLE_TOKEN_URL,{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,
      client_secret:env.GOOGLE_CLIENT_SECRET,code,code_verifier:pending.verifier,
      redirect_uri:redirectUri(request.url),grant_type:'authorization_code'}),
  });
  if(!response.ok)throw new Error('Upstream token exchange failed.');
  const token=await response.json();
  if(typeof token.refresh_token!=='string'||!token.refresh_token ||
    typeof token.access_token!=='string'||!token.access_token)
    throw new Error('Google did not issue a renewable authorization.');
  const granted=typeof token.scope==='string'?token.scope.split(/\s+/).filter(Boolean):[];
  if(!def.scopes.every(scope=>granted.includes(scope)))
    throw new Error('Required Google scope was not granted.');
  const identityResponse=await requestIdentity('https://www.googleapis.com/oauth2/v3/userinfo',{
    headers:{Authorization:'Bearer '+token.access_token,Accept:'application/json'},
  });
  if(!identityResponse.ok)throw new Error('Could not verify Google provider identity.');
  const identity=await identityResponse.json();
  if(typeof identity.sub!=='string'||!identity.sub||identity.email_verified!==true)
    throw new Error('Google provider account identity is invalid.');
  return authorizeDataSource({env,ownerUserId:row.ownerUserId,sourceId:row.sourceId,
    token:token.refresh_token,grantedScopes:granted,providerAccountId:identity.sub});
}
