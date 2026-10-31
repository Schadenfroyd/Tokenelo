/** Current interpretation is separate from the immutable pre-projection event rows.
 * Owned connections route unqualified event SQL consistently, including index hints.
 * Explicit main.events is the retained recorded basis. Foreign databases are never routed.
 * This is a compatibility policy, not authentication or runtime attestation. */
import type { TokeneloDb } from './db.js';

// Earlier internal copies lack the current identity/audit guards. Require the
// exact layout; these uninstalled candidates are not upgrade-compatible releases.
export const EVENT_PROJECTION_POLICY = 7;
export const CURRENT_EVENT_TABLE = 'event_projection';
const configured = new WeakSet<object>();

type Token = { start: number; end: number; value: string; kind: 'identifier' | 'literal' | 'punctuation'; quoted?: boolean };
/** Tokenize only enough to distinguish identifiers from strings/comments; values are never SQL. */
function sqlTokens(sql: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < sql.length;) {
    const start = i, ch = sql[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith('/*', i)) { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let value = ''; i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) { value += close; i += 2; continue; }
          i++; break;
        }
        value += sql[i++]!;
      }
      out.push({ start, end: i, value, kind: ch === "'" ? 'literal' : 'identifier', quoted: true }); continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      i++; while (i < sql.length && /[A-Za-z_0-9$]/.test(sql[i]!)) i++;
      out.push({ start, end: i, value: sql.slice(start, i), kind: 'identifier' }); continue;
    }
    out.push({ start, end: ++i, value: ch, kind: 'punctuation' });
  }
  return out;
}

/** Central owned-ledger basis: all ordinary read/write/report SQL uses the same physical
 * projection and rowid indexes. Quoted values, aggregate aliases and comments are unchanged.
 * main.events is deliberately never substituted; it is immutable retained evidence. */
export function currentEventSql(sql: string): string {
  if (!/events/i.test(sql)) return sql;
  const tokens = sqlTokens(sql), edits = new Map<number, string>();
  const word = (i: number): string => tokens[i]?.value.toLowerCase() ?? '';
  const keyword = (i: number, value: string): boolean => tokens[i]?.kind === 'identifier' && !tokens[i]?.quoted && word(i) === value;
  const depths: number[] = [], closes = new Map<number, number>(), stack: number[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.value === ')' && tokens[i]!.kind === 'punctuation') {
      depth--; const open = stack.pop(); if (open !== undefined) closes.set(open, i);
    }
    depths[i] = depth;
    if (tokens[i]!.value === '(' && tokens[i]!.kind === 'punctuation') { stack.push(i); depth++; }
  }
  // A WITH binding is visible throughout its statement, including recursive bodies.
  // Its enclosing parentheses/semicolon bound visibility, rather than all SQL text.
  const cteEvents: { start: number; end: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!keyword(i, 'with')) continue;
    let cursor = i + 1, shadows = false;
    if (keyword(cursor, 'recursive')) cursor++;
    while (tokens[cursor]?.kind === 'identifier') {
      const name = word(cursor++);
      if (tokens[cursor]?.value === '(') { const close = closes.get(cursor); if (close === undefined) break; cursor = close + 1; }
      if (!keyword(cursor++, 'as')) break;
      if (keyword(cursor, 'not')) cursor++;
      if (keyword(cursor, 'materialized')) cursor++;
      if (tokens[cursor]?.value !== '(') break;
      const close = closes.get(cursor); if (close === undefined) break;
      shadows ||= name === 'events'; cursor = close + 1;
      if (tokens[cursor]?.value !== ',') break;
      cursor++;
    }
    if (shadows) {
      let end = tokens.length;
      for (let j = i + 1; j < tokens.length; j++) {
        if (depths[j]! < depths[i]! || tokens[j]!.value === ';' && depths[j] === depths[i]) { end = j; break; }
      }
      cteEvents.push({ start: i, end });
    }
  }
  const shadowed = (i: number): boolean => cteEvents.some(r => i >= r.start && i < r.end);
  type Scope = { parent?: number; read: boolean; from: boolean; implicitEvents: boolean; namedEvents: boolean; lastRouted: boolean };
  const scopes: Scope[] = [], active = new Map<number, number>(), statementRoots=new Map<number,number>(), tokenScope: number[] = [], joinedDepths = new Set<number>();
  const tableTokens = new Map<number, string>(), hintRouted = new Set<number>(), ddlIndexRouted = new Set<number>();
  const makeScope = (d: number, parent?: number, read = false): number => {
    const id = scopes.push({ parent, read, from: false, implicitEvents: false, namedEvents: false, lastRouted: false }) - 1;
    active.set(d, id); return id;
  };
  makeScope(0);
  let awaitingTable = false, awaitingWriteTarget = false, statementStart = 0, createIndex = false, createTrigger = false, explicitIndexSchema = false, explicitTriggerSchema = false, indexDeclaration: number | undefined;
  const triggerDeclarations = new Set<number>();
  const clauseEnds = new Set(['select', 'where', 'group', 'having', 'order', 'limit', 'offset', 'returning', 'set', 'values', 'union', 'intersect', 'except']);
  const aliasEnds = new Set(['select', 'where', 'group', 'having', 'order', 'window', 'limit', 'offset', 'returning', 'set', 'values', 'union', 'intersect', 'except', 'join', 'left', 'right', 'full', 'inner', 'cross', 'natural', 'on', 'using', 'indexed', 'not']);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!, d = depths[i]!;
    for (const key of active.keys()) if (key > d) { active.delete(key); joinedDepths.delete(key); }
    let id = active.get(d);
    if (id === undefined) {
      const parent = active.get(d - 1); id = makeScope(d, parent, joinedDepths.has(d) && parent !== undefined && scopes[parent]!.read);
      if (joinedDepths.has(d)) scopes[id]!.from = true;
    }
    if(keyword(i,'insert')||keyword(i,'replace')&&keyword(i+1,'into')||keyword(i,'delete')||keyword(i,'update')&&!keyword(i-1,'do'))statementRoots.set(d,id);
    if (keyword(i, 'select')) id = makeScope(d, statementRoots.get(d) ?? active.get(d - 1), true);
    if((keyword(i,'on')&&keyword(i+1,'conflict')||keyword(i,'returning'))&&statementRoots.has(d)){
      id=statementRoots.get(d)!;active.set(d,id);scopes[id]!.from=false;
    }
    tokenScope[i] = id;
    const scope = scopes[id]!;
    if (t.value === ';' && t.kind === 'punctuation') {
      active.clear(); statementRoots.clear();makeScope(0); awaitingTable = false; statementStart = i + 1;
      createIndex = false; createTrigger = false; explicitIndexSchema = false; explicitTriggerSchema = false; indexDeclaration = undefined; joinedDepths.clear(); continue;
    }
    if (keyword(i, 'index') && keyword(statementStart, 'create') || keyword(i, 'index') && keyword(statementStart, 'drop')) {
      createIndex = keyword(statementStart, 'create');
      let declaration = i + 1;
      while (keyword(declaration, 'if') || keyword(declaration, 'not') || keyword(declaration, 'exists')) declaration++;
      explicitIndexSchema = tokens[declaration + 1]?.value === '.';
      indexDeclaration = explicitIndexSchema ? declaration + 2 : declaration;
      if (!createIndex && !explicitIndexSchema) ddlIndexRouted.add(indexDeclaration);
    }
    if (keyword(i, 'trigger') && (keyword(statementStart, 'create') || keyword(statementStart, 'drop'))) {
      createTrigger = keyword(statementStart, 'create'); let declaration = i + 1;
      while (keyword(declaration, 'if') || keyword(declaration, 'not') || keyword(declaration, 'exists')) declaration++;
      explicitTriggerSchema = tokens[declaration + 1]?.value === '.';
      if (!explicitTriggerSchema) triggerDeclarations.add(declaration);
    }
    if (keyword(i, 'begin') && createTrigger) {
      createTrigger = false; explicitTriggerSchema = false; statementStart = i + 1;
      active.clear(); statementRoots.clear(); makeScope(d); awaitingTable = false; awaitingWriteTarget = false;
      continue;
    }
    if (keyword(i, 'from') || keyword(i, 'join')) scope.from = true;
    else if (t.kind === 'identifier' && !t.quoted && clauseEnds.has(word(i))) scope.from = false;
    if (keyword(i, 'from') || keyword(i, 'join') || keyword(i, 'into') || keyword(i, 'update') && !keyword(i - 1, 'do') || keyword(i, 'table')
      || keyword(i, 'analyze') || keyword(i, 'reindex') || keyword(i, 'on') && (createIndex || createTrigger) || t.value === ',' && t.kind === 'punctuation' && scope.from) {
      awaitingTable = true;
      awaitingWriteTarget = keyword(i,'into') || keyword(i,'update') && !keyword(i-1,'do') || keyword(i,'from') && keyword(i-1,'delete');
      continue;
    }
    if (keyword(i, 'by') && keyword(i - 1, 'indexed')) {
      if (scope.lastRouted) hintRouted.add(i + 1);
      continue;
    }
    if (!awaitingTable) continue;
    if (t.kind === 'identifier' && !t.quoted && ['if', 'not', 'exists', 'or', 'abort', 'fail', 'ignore', 'replace', 'rollback'].includes(word(i))) continue;
    awaitingTable = false;
    let end = i, tableName = word(i), explicitSchema = false;
    if (t.value === '(' && t.kind === 'punctuation') {
      end = closes.get(i) ?? i; tableName = '';
      if (!keyword(i + 1, 'select') && !keyword(i + 1, 'with') && !keyword(i + 1, 'values')) {
        joinedDepths.add(d + 1); awaitingTable = true;
      }
    } else if (t.kind !== 'punctuation') {
      if (tokens[i + 1]?.value === '.') { end = i + 2; tableName = word(end); explicitSchema = true; }
    } else continue;
    const routed = tableName === 'events' && !explicitSchema && (!shadowed(i)||awaitingWriteTarget) && !(createIndex && explicitIndexSchema) && !(createTrigger && explicitTriggerSchema);
    awaitingWriteTarget = false;
    scope.lastRouted = routed;
    const tableNameToken = end;
    // Table-valued function arguments are not an alias. SQLite retains the same
    // alias namespace after a routed table gets its original implicit name.
    if (tokens[end + 1]?.value === '(') end = closes.get(end + 1) ?? end;
    let alias = end + 1;
    if (keyword(alias, 'as')) alias++;
    const aliasToken = tokens[alias];
    const hasAlias = !!aliasToken && aliasToken.kind !== 'punctuation' && !(aliasToken.kind === 'identifier' && !aliasToken.quoted && aliasEnds.has(word(alias)));
    if (routed) {
      const replacement = tokens[tableNameToken]!.kind === 'literal' ? `'${CURRENT_EVENT_TABLE}'` : CURRENT_EVENT_TABLE;
      tableTokens.set(tableNameToken, replacement + (scope.read && !hasAlias ? ' AS events' : ''));
      if (createIndex && indexDeclaration !== undefined) ddlIndexRouted.add(indexDeclaration);
    }
    if (hasAlias && word(alias) === 'events') scope.namedEvents = true;
    if (!hasAlias && tableName === 'events') {
      if (routed && !scope.read) scope.implicitEvents = true; else scope.namedEvents = true;
    }
  }
  const implicitQualifier = (i: number): boolean => {
    let scope: number | undefined = tokenScope[i];
    while (scope !== undefined) {
      const current: Scope = scopes[scope]!;
      if (current.namedEvents) return false;
      if (current.implicitEvents) return true;
      scope = current.parent;
    }
    return false;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!, previous = tokens[i - 1], next = tokens[i + 1];
    const name = word(i);
    const pragmaArgument = previous?.value === '(' && ['table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo'].includes(word(i - 2))
      && keyword(i - 3, 'pragma');
    if (tableTokens.has(i)) edits.set(i, tableTokens.get(i)!);
    else if (name === 'events' && (next?.value === '.' && previous?.value !== '.' && implicitQualifier(i) || pragmaArgument)) {
      edits.set(i, t.kind === 'literal' ? `'${CURRENT_EVENT_TABLE}'` : CURRENT_EVENT_TABLE);
    }
    if (name.startsWith('idx_events_') && (hintRouted.has(i) || ddlIndexRouted.has(i) || pragmaArgument))
      edits.set(i, t.kind === 'literal' ? `'${name.replace('idx_events_', 'idx_projection_')}'` : name.replace('idx_events_', 'idx_projection_'));
    if (t.kind === 'identifier' && name === 'events_invalidate_old_count_writer' && triggerDeclarations.has(i))
      edits.set(i, 'projection_invalidate_old_count_writer');
    if (name.startsWith('pragma_') && ['pragma_table_info','pragma_table_xinfo','pragma_index_list','pragma_index_info','pragma_index_xinfo'].includes(name)
      && next?.value === '(' && word(i + 4) !== 'main') {
      const argument = tokens[i + 2], value = word(i + 2);
      if (argument && (value === 'events' || value.startsWith('idx_events_')))
        edits.set(i + 2, argument.kind === 'literal' ? `'${value === 'events' ? CURRENT_EVENT_TABLE : value.replace('idx_events_','idx_projection_')}'` : value === 'events' ? CURRENT_EVENT_TABLE : value.replace('idx_events_','idx_projection_'));
    }
  }
  for (const [i, value] of [...edits].sort((a, b) => b[0] - a[0])) {
    const token = tokens[i]!; sql = sql.slice(0, token.start) + value + sql.slice(token.end);
  }
  return sql;
}

/** Call only for Tokenelo's owned ledger, after supported-schema checks/migrations.
 * Native methods remain bound to the actual DatabaseSync; no foreign DB is wrapped. */
export function assertCurrentEventLayout(db: TokeneloDb, required=false): boolean {
  const exists = db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(CURRENT_EVENT_TABLE);
  if (!exists) {
    if (required) throw new Error('Missing retained event layout; use its matching recovery pair');
    return false;
  }
  for (const name of ['events','event_projection_basis','event_interpretation_history','event_route_reports'])
    if (!db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(name))
      throw new Error('Missing retained event layout; use its matching recovery pair');
  const basis = db.prepare('SELECT policy FROM main.event_projection_basis WHERE singleton=1').get() as { policy: number } | undefined;
  if (!basis || basis.policy !== EVENT_PROJECTION_POLICY) throw new Error('Unsupported current event projection policy');
  return true;
}

function assertRetainedTableMaintenance(sql:string,protectedTriggers:Set<string>):void {
  const tokens=sqlTokens(sql),names=new Set(['events',CURRENT_EVENT_TABLE,'event_projection_basis','event_interpretation_history','event_route_reports','sqlite_sequence']);
  const keyword=(i:number,value:string)=>tokens[i]?.kind==='identifier'&&!tokens[i]?.quoted&&tokens[i]?.value.toLowerCase()===value;
  const targetAt=(start:number)=>{let target=start;while(keyword(target,'if')||keyword(target,'not')||keyword(target,'exists'))target++;if(keyword(target,'or')&&['rollback','abort','replace','fail','ignore'].some(x=>keyword(target+1,x)))target+=2;const schema=tokens[target+1]?.value==='.'?tokens[target]?.value.toLowerCase():undefined;if(schema)target+=2;return{name:tokens[target]?.kind!=='punctuation'?tokens[target]?.value.toLowerCase():undefined,schema};};
  const refuse=()=>{throw new Error('Destructive maintenance of the retained event layout requires matching recovery');};
  for(let i=0;i<tokens.length;i++){
    if((keyword(i,'drop')||keyword(i,'alter'))&&(keyword(i+1,'table')||keyword(i+1,'trigger'))){
      const target=targetAt(i+2);if(target.name&&(keyword(i+1,'table')?names.has(target.name):protectedTriggers.has(target.name)))refuse();
    }
    if(keyword(i,'create')){
      const temporary=keyword(i+1,'temp')||keyword(i+1,'temporary');const table=i+(temporary?2:1);
      if(keyword(table,'table')||keyword(table,'view')){const target=targetAt(table+1);if(target.name&&names.has(target.name)&&(temporary||target.schema==='temp'))refuse();}
    }
    if(keyword(i,'update')||keyword(i,'into')||keyword(i,'from')&&keyword(i-1,'delete')){
      if(targetAt(i+1).name==='sqlite_sequence')refuse();
    }
  }
}

export function configureCurrentEventBasis(db: TokeneloDb): void {
  if (configured.has(db)) return;
  if (!assertCurrentEventLayout(db)) return;
  const prepare = db.prepare.bind(db), exec = db.exec.bind(db);
  const protectedTriggers=new Set((prepare("SELECT name FROM main.sqlite_schema WHERE type='trigger'").all() as {name:string}[]).map(x=>x.name.toLowerCase()));
  const sqlMemo=new Map<string,string>();
  const routed=(sql:string):string=>{
    const hit=sqlMemo.get(sql);if(hit!==undefined)return hit;
    assertRetainedTableMaintenance(sql,protectedTriggers);
    const result=currentEventSql(sql);if(sqlMemo.size>=256)sqlMemo.delete(sqlMemo.keys().next().value!);
    sqlMemo.set(sql,result);return result;
  };
  db.prepare = ((sql: string) => prepare(routed(sql))) as TokeneloDb['prepare'];
  db.exec = ((sql: string) => exec(routed(sql))) as TokeneloDb['exec'];
  configured.add(db);
}

/** Each current writable owned connection supplies this supported compatibility policy.
 * Missing functions on old connections fail closed before cursor/event writes commit. */
export function registerCurrentWriterPolicy(db: TokeneloDb): void {
  // Connection-local: REPLACE must run the deletion audit/protection triggers.
  db.exec('PRAGMA recursive_triggers = ON');
  db.function('tokenelo_event_writer_policy', {deterministic:true}, () => EVENT_PROJECTION_POLICY);
}

/** Uses raw native methods during migration, before the current-basis routing is installed. */
export function createEventProjection(db: TokeneloDb): void {
  const schema = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='events'").get() as { sql: string };
  if (!schema) throw new Error('Original event schema missing');
  db.exec(schema.sql.replace(/^CREATE TABLE\s+(?:"events"|events)(?=\s|\()/i, `CREATE TABLE ${CURRENT_EVENT_TABLE}`)
    .replace(/\bid\s+TEXT\s+PRIMARY KEY/i,'id TEXT NOT NULL UNIQUE')
    .replace('(','(rowid INTEGER PRIMARY KEY AUTOINCREMENT, '));
  const columns = (db.prepare('PRAGMA main.table_info(events)').all() as { name: string }[]).map(c => `"${c.name.replaceAll('"', '""')}"`);
  db.exec(`INSERT INTO ${CURRENT_EVENT_TABLE}(rowid,${columns.join(',')}) SELECT rowid,${columns.join(',')} FROM main.events ORDER BY rowid`);
  const indexes = db.prepare("SELECT name,sql FROM main.sqlite_schema WHERE type='index' AND tbl_name='events' AND sql IS NOT NULL ORDER BY name").all() as { name: string; sql: string }[];
  for (const index of indexes) {
    if (!/^idx_events_[A-Za-z0-9_]+$/.test(index.name)) throw new Error('Unsupported original event index');
    db.exec(index.sql.replace(index.name, index.name.replace('idx_events_', 'idx_projection_')).replace(/\bON\s+(?:"events"|events)(?=\s|\()/i, `ON ${CURRENT_EVENT_TABLE}`));
  }
  // Empty and sparse local populations must seek the provider rather than scan all time rows.
  db.exec(`CREATE INDEX idx_projection_provider_ts ON ${CURRENT_EVENT_TABLE}(provider,ts)`);
  const triggers = db.prepare("SELECT name,sql FROM main.sqlite_schema WHERE type='trigger' AND tbl_name='events' ORDER BY name").all() as { name: string; sql: string }[];
  for (const trigger of triggers) {
    if (!/^events_invalidate_old_count_writer$/.test(trigger.name)) throw new Error('Unsupported original event trigger');
    db.exec(trigger.sql.replace(trigger.name, 'projection_invalidate_old_count_writer').replace(/\bON events\b/g, `ON ${CURRENT_EVENT_TABLE}`).replace(/\bUPDATE events\b/g, `UPDATE ${CURRENT_EVENT_TABLE}`));
  }
  // First supported observations also become immutable recorded rows. Replayed updates
  // never overwrite them; every changed current interpretation retains its prior full row.
  const historySchema = schema.sql.replace(/^CREATE TABLE\s+(?:"events"|events)(?=\s|\()/i, 'CREATE TABLE event_interpretation_history')
    .replace(/\bid\s+TEXT\s+PRIMARY KEY/i, 'id TEXT NOT NULL')
    .replace('(', "(history_id INTEGER PRIMARY KEY, prior_rowid INTEGER NOT NULL, captured_at_ms INTEGER NOT NULL, change_kind TEXT NOT NULL CHECK(change_kind IN ('update','delete')), ");
  db.exec(historySchema);
  db.exec(`CREATE TABLE event_route_reports(event_id TEXT NOT NULL,source TEXT NOT NULL,component_index INTEGER NOT NULL,
    model TEXT NOT NULL,speed TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('local','hosted','unknown')),evidence TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL DEFAULT(CAST(strftime('%s','now') AS INTEGER)*1000),
    PRIMARY KEY(event_id,source,component_index,model,speed,kind,evidence));`);
  const names=columns.join(','),newValues=columns.map(c=>`NEW.${c}`).join(','),oldValues=columns.map(c=>`OLD.${c}`).join(',');
  db.exec(`CREATE TRIGGER require_recorded_explicit_row_identity BEFORE INSERT ON ${CURRENT_EVENT_TABLE}
    WHEN NEW.rowid IS NOT -1 AND NOT EXISTS(SELECT 1 FROM events WHERE id=NEW.id AND rowid=NEW.rowid)
    BEGIN SELECT RAISE(ABORT,'Explicit current event identity must already be recorded'); END;
    CREATE TRIGGER capture_first_recorded_event AFTER INSERT ON ${CURRENT_EVENT_TABLE}
    BEGIN
      SELECT CASE WHEN NEW.rowid<=0 AND NOT EXISTS(SELECT 1 FROM events WHERE id=NEW.id AND rowid=NEW.rowid)
        THEN RAISE(ABORT,'New current event identity requires positive allocation') END;
      INSERT INTO events(rowid,${names}) SELECT NEW.rowid,${newValues} WHERE NOT EXISTS(SELECT 1 FROM events WHERE id=NEW.id);
    END;
    CREATE TRIGGER preserve_inserted_event_identity AFTER INSERT ON ${CURRENT_EVENT_TABLE}
    WHEN EXISTS(SELECT 1 FROM events WHERE id=NEW.id AND rowid IS NOT NEW.rowid)
    BEGIN SELECT RAISE(ABORT,'Current event identity is immutable'); END;
    CREATE TRIGGER retain_prior_event_interpretation BEFORE UPDATE ON ${CURRENT_EVENT_TABLE}
    WHEN ${columns.map(c=>`NEW.${c} IS NOT OLD.${c}`).join(' OR ')}
    BEGIN INSERT INTO event_interpretation_history(prior_rowid,captured_at_ms,change_kind,${names})
      VALUES(OLD.rowid,CAST(strftime('%s','now') AS INTEGER)*1000,'update',${oldValues}); END;
    CREATE TRIGGER retain_deleted_event_interpretation BEFORE DELETE ON ${CURRENT_EVENT_TABLE}
    BEGIN INSERT INTO event_interpretation_history(prior_rowid,captured_at_ms,change_kind,${names})
      VALUES(OLD.rowid,CAST(strftime('%s','now') AS INTEGER)*1000,'delete',${oldValues}); END;`);
  db.exec(`CREATE TABLE event_projection_basis (singleton INTEGER PRIMARY KEY CHECK(singleton=1), policy INTEGER NOT NULL);
    INSERT INTO event_projection_basis VALUES(1,${EVENT_PROJECTION_POLICY});`);
  const mutableTables=(db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name!='events' AND name NOT GLOB 'sqlite_*'").all()as{name:string}[]).map(t=>t.name);
  if(mutableTables.some(t=>!/^[a-z_]+$/.test(t)))throw new Error('Unsupported owned ledger table identifier');
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    db.exec(`CREATE TRIGGER recorded_events_reject_${operation} BEFORE ${operation} ON main.events
      ${operation==='INSERT'?`WHEN tokenelo_event_writer_policy() IS NOT (SELECT CASE WHEN policy=${EVENT_PROJECTION_POLICY} THEN policy ELSE NULL END FROM event_projection_basis WHERE singleton=1)
        OR (SELECT recursive_triggers FROM pragma_recursive_triggers) IS NOT 1
        OR EXISTS(SELECT 1 FROM events WHERE id=NEW.id OR (NEW.rowid IS NOT -1 AND rowid=NEW.rowid))
        OR NOT EXISTS(SELECT 1 FROM ${CURRENT_EVENT_TABLE} AS current WHERE ${columns.map(c=>`current.${c} IS NEW.${c}`).join(' AND ')})`:''}
      BEGIN SELECT RAISE(ABORT,'Recorded historical events are immutable; use a supported current Tokenelo writer'); END;`);
    for (const table of mutableTables)
      db.exec(`CREATE TRIGGER supported_writer_${table}_${operation} BEFORE ${operation} ON ${table}
        WHEN tokenelo_event_writer_policy() IS NOT (SELECT CASE WHEN policy=${EVENT_PROJECTION_POLICY} THEN policy ELSE NULL END FROM event_projection_basis WHERE singleton=1)
          OR (SELECT recursive_triggers FROM pragma_recursive_triggers) IS NOT 1
        BEGIN SELECT RAISE(ABORT,'Unsupported current Tokenelo writer policy'); END;`);
  }
  db.exec(`CREATE TRIGGER preserve_current_event_identity BEFORE UPDATE ON ${CURRENT_EVENT_TABLE}
    WHEN NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid
    BEGIN SELECT RAISE(ABORT,'Current event identity is immutable'); END;`);
  for(const operation of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER retained_history_reject_${operation} BEFORE ${operation} ON event_interpretation_history
    BEGIN SELECT RAISE(ABORT,'Event interpretation history is immutable'); END;`);
  for(const operation of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER route_reports_reject_${operation} BEFORE ${operation} ON event_route_reports
    BEGIN SELECT RAISE(ABORT,'Recorded serving-route reports are immutable'); END;`);
  db.exec(`CREATE TRIGGER retain_history_identity BEFORE INSERT ON event_interpretation_history
    WHEN EXISTS(SELECT 1 FROM event_interpretation_history WHERE history_id=NEW.history_id)
    BEGIN SELECT RAISE(IGNORE); END;
    CREATE TRIGGER retain_route_report_identity BEFORE INSERT ON event_route_reports
    BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM event_route_reports WHERE event_id=NEW.event_id AND source=NEW.source
      AND component_index=NEW.component_index AND model=NEW.model AND speed=NEW.speed AND kind=NEW.kind AND evidence=NEW.evidence)
      THEN RAISE(IGNORE) WHEN EXISTS(SELECT 1 FROM event_route_reports WHERE rowid=NEW.rowid)
      THEN RAISE(ABORT,'Recorded serving-route reports are immutable') END; END;
    CREATE TRIGGER require_history_allocation BEFORE INSERT ON event_interpretation_history
    WHEN NOT EXISTS(SELECT 1 FROM event_interpretation_history WHERE history_id=NEW.history_id)
      AND ((NEW.history_id IS NOT -1 AND NEW.history_id IS NOT (SELECT COALESCE(MAX(history_id),0)+1 FROM event_interpretation_history))
        OR NEW.captured_at_ms IS NOT CAST(strftime('%s','now') AS INTEGER)*1000
        OR NOT EXISTS(SELECT 1 FROM ${CURRENT_EVENT_TABLE} AS prior WHERE prior.rowid=NEW.prior_rowid AND ${columns.map(c=>`prior.${c} IS NEW.${c}`).join(' AND ')}))
    BEGIN SELECT RAISE(ABORT,'Invalid retained interpretation identity or prior row'); END;
    CREATE TRIGGER require_positive_history_identity AFTER INSERT ON event_interpretation_history
    WHEN NEW.history_id<=0
      OR NEW.history_id IS NOT (SELECT COALESCE(MAX(history_id),0)+1 FROM event_interpretation_history WHERE history_id<NEW.history_id)
      OR NEW.captured_at_ms IS NOT CAST(strftime('%s','now') AS INTEGER)*1000
      OR NOT EXISTS(SELECT 1 FROM ${CURRENT_EVENT_TABLE} AS prior WHERE prior.rowid=NEW.prior_rowid AND ${columns.map(c=>`prior.${c} IS NEW.${c}`).join(' AND ')})
    BEGIN SELECT RAISE(ABORT,'Invalid retained interpretation identity or prior row'); END;`);
}
