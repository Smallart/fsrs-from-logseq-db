import { type Kysely, sql } from 'kysely'

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
  // decks
  await db.schema
    .createTable('decks')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('name', 'varchar(255)', (c) => c.notNull())
    .addColumn('fsrs', 'jsonb', (c) => c.notNull().defaultTo(sql.raw(`'${DEFAULT_FSRS}'::jsonb`)))
    .addColumn('card_limit', 'jsonb', (c) => c.notNull().defaultTo(sql.raw(`'${DEFAULT_CARD_LIMIT}'::jsonb`)))
    .addColumn('p_due', 'real', (c) => c.defaultTo(0.7).notNull())
    .addColumn('deleted', 'boolean', (c) => c.defaultTo(false).notNull())
    .addColumn('created', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .addColumn('updated', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .execute()
  await db.schema.createIndex('decks_name_index').on('decks').columns(['name']).execute()

  // notes
  await db.schema
    .createTable('notes')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('did', 'integer', (c) => c.references('decks.id').onDelete('cascade').notNull())
    .addColumn('logseq_uuid', 'varchar(255)', (c) => c.notNull())
    .addColumn('page_id', 'varchar(255)')
    .addColumn('question', 'text', (c) => c.notNull())
    .addColumn('answer', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('content_hash', 'varchar(64)', (c) => c.notNull())
    .addColumn('source', 'varchar(255)', (c) => c.notNull().defaultTo('logseq'))
    .addColumn('deleted', 'boolean', (c) => c.defaultTo(false).notNull())
    .addColumn('created', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .addColumn('updated', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .execute()
  await db.schema.createIndex('notes_logseq_uuid_index').on('notes').columns(['logseq_uuid']).unique().execute()
  await db.schema.createIndex('notes_did_index').on('notes').columns(['did']).execute()

  // cards
  await db.schema
    .createTable('cards')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('did', 'integer', (c) => c.references('decks.id').onDelete('cascade').notNull())
    .addColumn('nid', 'integer', (c) => c.references('notes.id').onDelete('cascade').notNull())
    .addColumn('due', 'bigint', (c) => c.notNull())
    .addColumn('stability', 'float8', (c) => c.notNull().defaultTo(0))
    .addColumn('difficulty', 'float8', (c) => c.notNull().defaultTo(0))
    .addColumn('elapsed_days', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('scheduled_days', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('reps', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('lapses', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('state', 'int2', (c) => c.notNull().defaultTo(0))
    .addColumn('last_review', 'bigint')
    .addColumn('suspended', 'boolean', (c) => c.defaultTo(false).notNull())
    .addColumn('deleted', 'boolean', (c) => c.defaultTo(false).notNull())
    .addColumn('created', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .addColumn('updated', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .execute()
  await db.schema.createIndex('cards_did_state_index').on('cards').columns(['did', 'state']).execute()
  await db.schema.createIndex('cards_nid_index').on('cards').columns(['nid']).execute()
  await db.schema.createIndex('cards_due_index').on('cards').columns(['due']).execute()

  // revlog
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
    .addColumn('elapsed_days', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('last_elapsed_days', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('scheduled_days', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('review', 'bigint', (c) => c.notNull())
    .addColumn('duration', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('deleted', 'boolean', (c) => c.defaultTo(false).notNull())
    .addColumn('offset', 'integer', (c) => c.notNull().defaultTo(0))
    .execute()
  await db.schema.createIndex('revlog_cid_index').on('revlog').columns(['cid']).execute()

  // config (single row, id=1)
  await db.schema
    .createTable('config')
    .addColumn('id', 'integer', (c) => c.primaryKey().defaultTo(1))
    .addColumn('token', 'text')
    .addColumn('graph_id', 'text')
    .execute()
  await db.insertInto('config').values({ id: 1, token: null, graph_id: null }).execute()

  // sync_meta (single row, id=1)
  await db.schema
    .createTable('sync_meta')
    .addColumn('id', 'integer', (c) => c.primaryKey().defaultTo(1))
    .addColumn('last_sync_at', 'bigint')
    .addColumn('last_full_check_at', 'bigint')
    .execute()
  await db.insertInto('sync_meta').values({ id: 1, last_sync_at: null, last_full_check_at: null }).execute()

  // default All deck
  await db.insertInto('decks').values({ name: 'All' }).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('sync_meta').execute()
  await db.schema.dropTable('config').execute()
  await db.schema.dropTable('revlog').execute()
  await db.schema.dropTable('cards').execute()
  await db.schema.dropTable('notes').execute()
  await db.schema.dropTable('decks').execute()
}
