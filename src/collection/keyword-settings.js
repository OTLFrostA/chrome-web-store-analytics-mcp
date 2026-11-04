// Account- and extension-scoped keyword settings for the two independent ranking sources.
// Keyword configuration is runtime D1 data; deleting or disabling a keyword never deletes history.

const MAX_KEYWORDS = Object.freeze({google:100,webstore:20});

export function validateKeywordSettings(engine, entries) {
  const max = MAX_KEYWORDS[engine];
  if (!max) throw new Error('Unsupported keyword monitoring source.');
  if (!Array.isArray(entries) || entries.length > max) {
    throw new Error('Provide at most ' + max + ' keywords for this source.');
  }
  const seen = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.keyword !== 'string' || typeof entry.enabled !== 'boolean') {
      throw new Error('Each keyword must have a phrase and an enabled boolean.');
    }
    const keyword = entry.keyword.trim();
    if (keyword.length < 1 || keyword.length > 120) {
      throw new Error('Keyword phrases must be between 1 and 120 characters.');
    }
    const folded = keyword.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw new Error('Duplicate keyword phrase: ' + keyword);
    seen.add(folded);
    return {keyword, enabled:entry.enabled};
  });
}

export async function readKeywordSettings(db, googleSub, itemId) {
  const [google,webstore] = await Promise.all([
    db.prepare('SELECT keyword,enabled FROM google_search_keywords ' +
      'WHERE google_sub=? AND item_id=? ORDER BY keyword COLLATE NOCASE')
      .bind(googleSub,itemId).all(),
    db.prepare('SELECT keyword,enabled FROM collector_keywords ' +
      'WHERE google_sub=? AND item_id=? ORDER BY keyword COLLATE NOCASE')
      .bind(googleSub,itemId).all(),
  ]);
  const normalize = rows => (rows?.results ?? []).map(row =>
    ({keyword:row.keyword,enabled:row.enabled === 1 || row.enabled === true}));
  return {google:normalize(google),webstore:normalize(webstore)};
}

export async function saveKeywordSettings(db, googleSub, itemId, engine, entries) {
  const normalized = validateKeywordSettings(engine,entries);
  const queries = engine === 'google'
    ? [db.prepare('DELETE FROM google_search_keywords WHERE google_sub=? AND item_id=?')
      .bind(googleSub,itemId), ...normalized.map(({keyword,enabled}) =>
      db.prepare('INSERT INTO google_search_keywords ' +
        '(google_sub,item_id,keyword,market,device,enabled) ' +
        "VALUES (?,?,?,'us/en','desktop',?)")
        .bind(googleSub,itemId,keyword,enabled ? 1 : 0))]
    : [db.prepare('DELETE FROM collector_keywords WHERE google_sub=? AND item_id=?')
      .bind(googleSub,itemId), ...normalized.map(({keyword,enabled}) =>
      db.prepare('INSERT INTO collector_keywords ' +
        "(google_sub,item_id,keyword,locale,enabled) VALUES (?,?,?,'en-US',?)")
        .bind(googleSub,itemId,keyword,enabled ? 1 : 0))];
  // D1 batch is transactional: a failed save cannot partially replace a keyword list.
  await db.batch(queries);
  return normalized;
}
