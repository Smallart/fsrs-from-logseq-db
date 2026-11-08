import type { Generated } from 'kysely'

// Kysely table types — mirror the gateway's FlatCard / TsFsrsCard shapes
// verbatim (camelCase columns, see docs/WEB_FSRS_INTEGRATION.md §3).
// Migration: src/server/migrations/logs/20261108_deck_anchors.ts
// Columns with DB defaults / auto-increment are wrapped in Generated<>,
// so they can be omitted on INSERT.

export type DeckTable = {
  id: Generated<number>
  /** deck name = the #Cards deck block's title; 'All' for the virtual base deck */
  name: string
  /** #Cards deck block uuid (stable anchor); null for the base All deck */
  anchorUuid: Generated<string | null>
  /** user-provided display name; null → display falls back to name */
  deskName: Generated<string | null>
  fsrs: Generated<FSRSParametersRow>
  cardLimit: Generated<CardLimitRow>
  pDue: Generated<number>
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

/** FlatCard minus card/answer — answers are requested per-card at review. */
export type NoteTable = {
  id: Generated<number>
  did: number
  /** Logseq block UUID — the stable join key with gateway cards */
  logseq_uuid: string
  /** Logseq block db/id — used for the gateway's single-card endpoints */
  dbId: Generated<number | null>
  question: string
  /** first non-builtin tag title, e.g. 'Dictionary-Item'; null if none */
  deck: Generated<string | null>
  pageId: Generated<number | null>
  parentId: Generated<number | null>
  tags: Generated<string[]>
  /** custom `*.property/*` values except the fsrs plugin's */
  properties: Generated<Record<string, unknown> | null>
  /** card_params | fsrs-legacy | default */
  cardSource: Generated<string>
  /** block creation time, ms (from Logseq) */
  createdAt: Generated<number | null>
  /** block update time, ms — content-change hint (§4.3) */
  updatedAt: Generated<number | null>
  deleted: Generated<boolean>
  created: Generated<number>
  updated: Generated<number>
}

/** TsFsrsCard verbatim (+ local bookkeeping columns). */
export type CardTable = {
  id: Generated<number>
  did: number
  nid: number
  state: Generated<number> // 0 new / 1 learning / 2 review / 3 relearning
  due: Generated<number> // ms
  stability: Generated<number> // days
  difficulty: Generated<number> // 1–10
  /** ★ arbitration key: the newest lastReview wins (§4.1) */
  lastReview: number | null
  learningSteps: Generated<number> // plugin extra (ts-fsrs 4.5 core ignores it)
  priorState: Generated<number> // state before the last review (plugin extra)
  elapsedDays: Generated<number>
  scheduledDays: Generated<number>
  reps: Generated<number>
  lapses: Generated<number>
  lastRating: Generated<number | null> // 1 again / 2 hard / 3 good / 4 easy
  cardSource: Generated<string>
  /** local review awaiting gateway PUSH (PULL/merge/PUSH §4.2) */
  dirty: Generated<boolean>
  suspended: Generated<boolean>
  deleted: Generated<boolean>
  created: Generated<number>
  updated: Generated<number>
}

/** pre-review snapshot per review — powers undo (fsrs.rollback). */
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
  elapsedDays: Generated<number>
  lastElapsedDays: Generated<number>
  scheduledDays: Generated<number>
  review: number
  duration: Generated<number>
  deleted: Generated<boolean>
  offset: Generated<number>
}

export type ConfigTable = {
  id: Generated<number>
  /** logseq-cli2http gateway base URL, e.g. http://127.0.0.1:3000 */
  gatewayUrl: string | null
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
