import type { Generated } from 'kysely'

// Kysely table types — mirror migrations/logs/20261104_init.ts
// Columns with DB defaults / auto-increment are wrapped in Generated<>,
// so they can be omitted on INSERT.

export type DeckTable = {
  id: Generated<number>
  name: string
  /** source tag page uuid — null for the base All deck, UNIQUE otherwise */
  logseq_uuid: Generated<string | null>
  /** source tag title, e.g. 'vocab' (null for the base deck) */
  tag_name: Generated<string | null>
  /** user-provided display name; null → display falls back to name */
  desk_name: Generated<string | null>
  fsrs: Generated<FSRSParametersRow>
  card_limit: Generated<CardLimitRow>
  p_due: Generated<number>
  deleted: Generated<boolean>
  created: Generated<number>
  updated: Generated<number>
}

/** note ↔ deck membership junction (a note can be in multiple decks). */
export type NoteDeckTable = {
  id: Generated<number>
  nid: number
  did: number
  /** excluded from THIS deck only — the note may still be active in others */
  deleted: Generated<boolean>
  created: Generated<number>
}

export type NoteTable = {
  id: Generated<number>
  did: number
  logseq_uuid: string
  page_id: string | null
  question: string
  answer: Generated<string[]>
  content_hash: string
  source: Generated<string>
  deleted: Generated<boolean>
  created: Generated<number>
  updated: Generated<number>
}

export type CardTable = {
  id: Generated<number>
  did: number
  nid: number
  due: number
  stability: Generated<number>
  difficulty: Generated<number>
  elapsed_days: Generated<number>
  scheduled_days: Generated<number>
  reps: Generated<number>
  lapses: Generated<number>
  state: Generated<number>
  last_review: number | null
  suspended: Generated<boolean>
  deleted: Generated<boolean>
  created: Generated<number>
  updated: Generated<number>
}

export type RevlogTable = {
  id: Generated<number>
  did: number
  nid: number
  cid: number
  grade: number
  state: number
  due: number
  stability: number
  difficulty: number
  elapsed_days: Generated<number>
  last_elapsed_days: Generated<number>
  scheduled_days: Generated<number>
  review: number
  duration: Generated<number>
  deleted: Generated<boolean>
  offset: Generated<number>
}

export type ConfigTable = {
  id: Generated<number>
  token: string | null
  graph_id: string | null
}

export type SyncMetaTable = {
  id: Generated<number>
  last_sync_at: number | null
  last_full_check_at: number | null
}

// jsonb payloads
export type FSRSParametersRow = {
  request_retention: number
  maximum_interval: number
  enable_fuzz: boolean
  enable_short_term: boolean
  w: number[]
  day_start: number // hour of day, e.g. 3 = 03:00
}

export type CardLimitRow = {
  new: number
  review: number
  learning: number
}

export interface Database {
  decks: DeckTable
  notes: NoteTable
  cards: CardTable
  revlog: RevlogTable
  note_decks: NoteDeckTable
  config: ConfigTable
  sync_meta: SyncMetaTable
}
