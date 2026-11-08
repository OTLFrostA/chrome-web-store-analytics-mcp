// Application users are not the same as MCP OAuth logins or downstream Google accounts.
// This mapping allows additional login identities to be linked without rewriting sources.
export async function resolveAppUser(db,{identityProvider,identitySubject}) {
  if(typeof identityProvider!=='string'||!/^[a-z0-9_-]{1,40}$/.test(identityProvider)||
    typeof identitySubject!=='string'||!identitySubject||identitySubject.length>250)
    throw new TypeError('Invalid authenticated identity.');
  const read=()=>db.prepare(`SELECT user_id AS userId FROM app_user_identities
    WHERE identity_provider=? AND identity_subject=?`).bind(identityProvider,identitySubject).first();
  const existing=await read();
  if(existing)return existing.userId;
  const id=crypto.randomUUID();
  await db.prepare('INSERT INTO app_users(user_id) VALUES(?)').bind(id).run();
  // Another concurrent request may have registered the same identity first.
  await db.prepare(`INSERT INTO app_user_identities(identity_provider,identity_subject,user_id)
    VALUES(?,?,?) ON CONFLICT(identity_provider,identity_subject) DO NOTHING`)
    .bind(identityProvider,identitySubject,id).run();
  const mapped=await read();
  if(!mapped)throw new Error('Could not associate authenticated user.');
  return mapped.userId;
}
