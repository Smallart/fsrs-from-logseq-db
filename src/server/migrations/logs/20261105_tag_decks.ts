import { type Kysely, sql } from 'kysely'

// Tag decks: a Logseq tag becomes a deck. Cards are shared (classification
// model): a note belongs to multiple decks via the note_decks junction, and
// the single card per note is picked through that membership.
const nowMs = () => sql`extract(epoch from now()) * 1000`

export async function up(db: Kysely<any>): Promise<void> {
  // decks: link a deck to its source Logseq tag.
  //  - logseq_uuid: tag page uuid (UNIQUE, null for the base All deck)
  //  - tag_name:    source tag title, e.g. 'vocab'
  //  - desk_name:   user-provided display name (null → display falls back to name)
  await db.schema.alterTable('decks').addColumn('logseq_uuid', 'varchar(255)').execute()
  await db.schema.alterTable('decks').addColumn('tag_name', 'varchar(255)').execute()
  await db.schema.alterTable('decks').addColumn('desk_name', 'varchar(255)').execute()
  // NULLs are allowed multiple times in PG unique indexes, so the base deck
  // (logseq_uuid = null) coexists with tag decks.
  await db.schema
    .createIndex('decks_logseq_uuid_index')
    .on('decks')
    .columns(['logseq_uuid'])
    .unique()
    .execute()

  // note_decks: note ↔ deck membership (the "notes.did contains multiple
  // values" relation). Soft delete: deleted=true means the note was excluded
  // from THIS deck only — it may still be active in others (and notes.deleted
  // stays the note-level "removed from the whole system" flag).
  await db.schema
    .createTable('note_decks')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('nid', 'integer', (c) => c.references('notes.id').onDelete('cascade').notNull())
    .addColumn('did', 'integer', (c) => c.references('decks.id').onDelete('cascade').notNull())
    .addColumn('deleted', 'boolean', (c) => c.defaultTo(false).notNull())
    .addColumn('created', 'bigint', (c) => c.defaultTo(nowMs()).notNull())
    .execute()
  await db.schema.createIndex('note_decks_nid_index').on('note_decks').columns(['nid']).execute()
  await db.schema.createIndex('note_decks_did_index').on('note_decks').columns(['did']).execute()
  await db.schema
    .createIndex('note_decks_nid_did_index')
    .on('note_decks')
    .columns(['nid', 'did'])
    .unique()
    .execute()

  // Backfill: every existing non-deleted note joins its own (base) deck.
  // Column defaults cover deleted=false / created.
  await sql`
    insert into note_decks (nid, did)
    select id, did from notes where deleted = false
    on conflict do nothing
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('note_decks').execute()
  await db.schema.dropIndex('decks_logseq_uuid_index').execute()
  await db.schema.alterTable('decks').dropColumn('desk_name').execute()
  await db.schema.alterTable('decks').dropColumn('tag_name').execute()
  await db.schema.alterTable('decks').dropColumn('logseq_uuid').execute()
}
