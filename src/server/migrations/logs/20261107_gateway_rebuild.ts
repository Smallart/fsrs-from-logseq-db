import { type Kysely, sql } from 'kysely'

// Gateway rebuild — fsrs-from-logseq-db becomes the web-fsrs client:
// the Logseq DB (block `card_params`) is the single source of truth, reached
// through the logseq-cli2http gateway. The local PG tables mirror the
// gateway's FlatCard / TsFsrsCard shapes verbatim (camelCase columns, no
// `answer` — answers are fetched per-card at review time).
//
// Old data is NOT migrated (decided): notes/cards/revlog rows are rebuilt from
// the next full gateway sync; decks are re-derived from card tags.

// Default FSRS-5 weights (ts-fsrs defaults)
const DEFAULT_W = [
  0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616,
  0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034,
  0.6567,
]

const DEFAULT_FSRS = JSON.stringify({
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_fuzz: true,
  enable_short_term: true,
  w: DEFAULT_W,
  day_start: 3,
})

const DEFAULT_CARD_LIMIT = JSON.stringify({
  new: 20,
  review: 999999,
  learning: 999999,
})

const nowMs = () => sql`extract(epoch from now()) * 1000`

export async function up(db: Kysely<any>): Promise<void> {
  // --- drop everything that mirrors Logseq data (keep nothing: rebuild) ---
  await db.schema.dropTable('revlog').ifExists().execute()
  await db.schema.dropTable('cards').ifExists().execute()
  await db.schema.dropTable('note_decks').ifExists().execute()
  await db.schema.dropTable('notes').ifExists().execute()
  await db.schema.dropTable('decks').ifExists().execute()
  await db.schema.dropTable('config').ifExists().execute()
  await db.schema.dropTable('sync_meta').ifExists().execute()

  // --- decks: anchored by tag NAME now (gateway cards carry tag titles,
  //     not tag uuids). The All deck has tagName null. ---
  await db.schema
    .createTable('decks')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('name', 'varchar(255)', (c) => c.notNull())
    .addColumn('tagName', 'varchar(255)') // source tag title; null for the All deck
    .addColumn('deskName', 'varchar(255)') // user display name; null → fall back to name
    .addColumn('fsrs', 'jsonb', (c) => c.notNull().defaultTo(sql.raw(`'${DEFAULT_FSRS}'::jsonb`)))
    .addColumn('cardLimit', 'jsonb', (c) => c.notNull().defaultTo(sql.raw(`'${DEFAULT_CARD_LIMIT}'::jsonb`)))
    .addColumn('pDue', 'real', (c) => c.defaultTo(0.7).notNull())
    .addColumn('deleted', 'boolean', (c) => c.defaultTo(false).notNull())
    .addColumn('created', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .addColumn('updated', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .execute()
  await db.schema.createIndex('decks_tag_name_index').on('decks').columns(['tagName']).execute()

  // --- notes = FlatCard minus `card`/`answer` (answers are requested
  //     per-card from the gateway at review time — never stored) ---
  await db.schema
    .createTable('notes')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('did', 'integer', (c) => c.references('decks.id').onDelete('cascade').notNull())
    .addColumn('logseq_uuid', 'varchar(255)', (c) => c.notNull())
    .addColumn('dbId', 'bigint') // Logseq block db/id — single-card gateway calls
    .addColumn('question', 'text', (c) => c.notNull())
    .addColumn('deck', 'varchar(255)') // first non-builtin tag name
    .addColumn('pageId', 'bigint')
    .addColumn('parentId', 'bigint')
    .addColumn('tags', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('properties', 'jsonb')
    .addColumn('cardSource', 'varchar(32)', (c) => c.notNull().defaultTo('default'))
    .addColumn('createdAt', 'bigint') // block creation time (ms, from Logseq)
    .addColumn('updatedAt', 'bigint') // block update time (ms) — content-change hint
    .addColumn('deleted', 'boolean', (c) => c.defaultTo(false).notNull())
    .addColumn('created', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .addColumn('updated', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .execute()
  await db.schema.createIndex('notes_logseq_uuid_index').on('notes').columns(['logseq_uuid']).unique().execute()
  await db.schema.createIndex('notes_db_id_index').on('notes').columns(['dbId']).execute()

  // --- cards = TsFsrsCard verbatim (+ local bookkeeping) ---
  await db.schema
    .createTable('cards')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('did', 'integer', (c) => c.references('decks.id').onDelete('cascade').notNull())
    .addColumn('nid', 'integer', (c) => c.references('notes.id').onDelete('cascade').notNull())
    .addColumn('state', 'int2', (c) => c.notNull().defaultTo(0))
    .addColumn('due', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('stability', 'float8', (c) => c.notNull().defaultTo(0))
    .addColumn('difficulty', 'float8', (c) => c.notNull().defaultTo(0))
    .addColumn('lastReview', 'bigint') // ★ arbitration key (newest wins)
    .addColumn('learningSteps', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('priorState', 'int2', (c) => c.notNull().defaultTo(0))
    .addColumn('elapsedDays', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('scheduledDays', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('reps', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('lapses', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('lastRating', 'int2')
    .addColumn('cardSource', 'varchar(32)', (c) => c.notNull().defaultTo('default'))
    .addColumn('dirty', 'boolean', (c) => c.notNull().defaultTo(false)) // local review awaiting gateway PUSH
    .addColumn('suspended', 'boolean', (c) => c.defaultTo(false).notNull())
    .addColumn('deleted', 'boolean', (c) => c.defaultTo(false).notNull())
    .addColumn('created', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .addColumn('updated', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .execute()
  await db.schema.createIndex('cards_did_state_index').on('cards').columns(['did', 'state']).execute()
  await db.schema.createIndex('cards_nid_index').on('cards').columns(['nid']).execute()
  await db.schema.createIndex('cards_due_index').on('cards').columns(['due']).execute()
  await db.schema.createIndex('cards_dirty_index').on('cards').columns(['dirty']).execute()

  // --- note ↔ deck membership (note may sit in several tag decks) ---
  await db.schema
    .createTable('note_decks')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('nid', 'integer', (c) => c.references('notes.id').onDelete('cascade').notNull())
    .addColumn('did', 'integer', (c) => c.references('decks.id').onDelete('cascade').notNull())
    .addColumn('deleted', 'boolean', (c) => c.defaultTo(false).notNull())
    .addColumn('created', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .execute()
  await db.schema.createIndex('note_decks_nid_did_index').on('note_decks').columns(['nid', 'did']).unique().execute()

  // --- revlog: pre-review snapshots for undo (camelCase, same semantics) ---
  await db.schema
    .createTable('revlog')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('did', 'integer', (c) => c.notNull())
    .addColumn('nid', 'integer', (c) => c.notNull())
    .addColumn('cid', 'integer', (c) => c.references('cards.id').onDelete('cascade').notNull())
    .addColumn('grade', 'int2', (c) => c.notNull())
    .addColumn('state', 'int2', (c) => c.notNull())
    .addColumn('due', 'bigint', (c) => c.notNull())
    .addColumn('stability', 'float8', (c) => c.notNull())
    .addColumn('difficulty', 'float8', (c) => c.notNull())
    .addColumn('elapsedDays', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('lastElapsedDays', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('scheduledDays', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('review', 'bigint', (c) => c.notNull())
    .addColumn('duration', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('deleted', 'boolean', (c) => c.defaultTo(false).notNull())
    .addColumn('offset', 'integer', (c) => c.notNull().defaultTo(0))
    .execute()
  await db.schema.createIndex('revlog_cid_index').on('revlog').columns(['cid']).execute()

  // --- config: single row, the gateway base URL ---
  await db.schema
    .createTable('config')
    .addColumn('id', 'integer', (c) => c.primaryKey().defaultTo(1))
    .addColumn('gatewayUrl', 'text')
    .execute()
  await db.insertInto('config').values({ id: 1, gatewayUrl: null }).execute()

  // --- sync_meta: single row, last full-pull timestamp ---
  await db.schema
    .createTable('sync_meta')
    .addColumn('id', 'integer', (c) => c.primaryKey().defaultTo(1))
    .addColumn('last_sync_at', 'bigint')
    .addColumn('last_full_check_at', 'bigint')
    .execute()
  await db.insertInto('sync_meta').values({ id: 1, last_sync_at: null, last_full_check_at: null }).execute()

  // --- the All deck (virtual deck containing every card) ---
  await db.insertInto('decks').values({ name: 'All' }).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  // no restore path: this migration intentionally drops legacy data
  await db.schema.dropTable('sync_meta').execute()
  await db.schema.dropTable('config').execute()
  await db.schema.dropTable('revlog').execute()
  await db.schema.dropTable('cards').execute()
  await db.schema.dropTable('note_decks').execute()
  await db.schema.dropTable('notes').execute()
  await db.schema.dropTable('decks').execute()
}
