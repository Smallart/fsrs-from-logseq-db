'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

type Row = {
  id: number
  did: number
  deck_name: string
  question: string
  state: number
  stability: number
  difficulty: number
  due: number
  suspended: boolean
  deleted: boolean
}

type DeckOption = { id: number; name: string }

type SortKey = 'due' | 'stability' | 'difficulty' | 'state'

const PAGE_SIZE = 50

const selectCls =
  'h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring'

// ts-fsrs State: 0=New, 1=Learning, 2=Review, 3=Relearning (same colors as the review page)
const STATE_LABELS = ['新卡', '学习中', '复习中', '重新学习']
const STATE_BADGE: Record<number, string> = {
  0: 'border-transparent bg-blue-100 text-blue-700',
  1: 'border-transparent bg-amber-100 text-amber-700',
  2: 'border-transparent bg-emerald-100 text-emerald-700',
  3: 'border-transparent bg-red-100 text-red-700',
}

// Row colors: deleted = red, suspended (not deleted) = amber, normal = default.
function rowClass(r: Row): string {
  if (r.deleted) return 'bg-red-50'
  if (r.suspended) return 'bg-amber-50'
  return ''
}

function fmtDue(due: number): string {
  return due > 0 ? new Date(due).toLocaleString('zh-CN') : '—'
}

/** Clickable table header: click cycles 升序 → 降序 → 取消. */
function SortableTh({
  label,
  k,
  sort,
  order,
  onToggle,
}: {
  label: string
  k: SortKey
  sort: SortKey | null
  order: 'asc' | 'desc'
  onToggle: (k: SortKey) => void
}) {
  const active = sort === k
  const Icon = !active ? ArrowUpDown : order === 'asc' ? ArrowUp : ArrowDown
  return (
    <th className="px-4 py-2.5 font-medium">
      <button
        type="button"
        className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
        onClick={() => onToggle(k)}
      >
        {label}
        <Icon className={`h-3.5 w-3.5 ${active ? 'text-foreground' : 'opacity-40'}`} />
      </button>
    </th>
  )
}

export default function CardsPage() {
  // filter inputs (answer is applied on submit, others take effect immediately)
  const [decks, setDecks] = useState<DeckOption[]>([])
  const [deckFilter, setDeckFilter] = useState('all')
  const [answerInput, setAnswerInput] = useState('')
  const [answerFilter, setAnswerFilter] = useState('')
  const [suspendedFilter, setSuspendedFilter] = useState('all')
  const [deletedFilter, setDeletedFilter] = useState('all')
  const [stateFilter, setStateFilter] = useState('all')

  // server-side sorting: click header → asc → desc → off (default id order)
  const [sort, setSort] = useState<SortKey | null>(null)
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')

  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)

  useEffect(() => {
    fetch('/api/decks')
      .then((r) => r.json())
      .then((d) =>
        setDecks((d?.decks ?? []).map((x: { id: number; name: string }) => ({ id: x.id, name: x.name }))),
      )
  }, [])

  const fetchCards = useCallback(
    async (offset: number) => {
      setLoading(true)
      try {
        const p = new URLSearchParams()
        if (deckFilter !== 'all') p.set('deck', deckFilter)
        if (answerFilter) p.set('answer', answerFilter)
        if (suspendedFilter !== 'all') p.set('suspended', suspendedFilter)
        if (deletedFilter !== 'all') p.set('deleted', deletedFilter)
        if (stateFilter !== 'all') p.set('state', stateFilter)
        if (sort) {
          p.set('sort', sort)
          p.set('order', order)
        }
        p.set('limit', String(PAGE_SIZE))
        p.set('offset', String(offset))

        const d = await fetch(`/api/cards?${p.toString()}`).then((r) => r.json())
        const list: Row[] = d?.cards ?? []
        const t: number = d?.total ?? 0

        if (offset === 0) {
          setRows(list)
        } else if (list.length > 0) {
          setRows((prev) => [...prev, ...list])
        }
        // keep the previous total when a "load more" comes back empty
        if (offset === 0 || list.length > 0) setTotal(t)
        setHasMore(list.length > 0 && offset + list.length < t)
      } finally {
        setLoading(false)
      }
    },
    [deckFilter, answerFilter, suspendedFilter, deletedFilter, stateFilter, sort, order],
  )

  useEffect(() => {
    fetchCards(0)
  }, [fetchCards])

  function applyAnswer() {
    setAnswerFilter(answerInput.trim())
  }

  function toggleSort(k: SortKey) {
    if (sort !== k) {
      setSort(k)
      setOrder('asc')
    } else if (order === 'asc') {
      setOrder('desc')
    } else {
      setSort(null)
    }
  }

  function loadMore() {
    fetchCards(rows.length)
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-3xl space-y-4 p-4">
      <Link href="/">
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
          返回
        </Button>
      </Link>
      <h1 className="text-xl font-bold">全部卡片</h1>

      {/* filter bar */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <select
            aria-label="Deck"
            className={selectCls}
            value={deckFilter}
            onChange={(e) => setDeckFilter(e.target.value)}
          >
            <option value="all">全部 Deck</option>
            {decks.map((d) => (
              <option key={d.id} value={String(d.id)}>
                {d.name}
              </option>
            ))}
          </select>

          <Input
            placeholder="搜索答案…"
            value={answerInput}
            onChange={(e) => setAnswerInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyAnswer()}
            className="w-44"
          />
          <Button size="sm" variant="secondary" onClick={applyAnswer} disabled={loading}>
            <Search className="h-4 w-4" />
            查询
          </Button>

          <select
            aria-label="状态"
            className={selectCls}
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
          >
            <option value="all">状态：全部</option>
            <option value="0">状态：新卡</option>
            <option value="1">状态：学习中</option>
            <option value="2">状态：复习中</option>
            <option value="3">状态：重新学习</option>
          </select>

          <select
            aria-label="挂起"
            className={selectCls}
            value={suspendedFilter}
            onChange={(e) => setSuspendedFilter(e.target.value)}
          >
            <option value="all">挂起：全部</option>
            <option value="1">挂起：是</option>
            <option value="0">挂起：否</option>
          </select>

          <select
            aria-label="删除"
            className={selectCls}
            value={deletedFilter}
            onChange={(e) => setDeletedFilter(e.target.value)}
          >
            <option value="all">删除：全部</option>
            <option value="1">删除：是</option>
            <option value="0">删除：否</option>
          </select>
        </CardContent>
      </Card>

      {/* result table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">问题</th>
                  <th className="px-4 py-2.5 font-medium">Deck</th>
                  <SortableTh label="状态" k="state" sort={sort} order={order} onToggle={toggleSort} />
                  <SortableTh label="稳定性" k="stability" sort={sort} order={order} onToggle={toggleSort} />
                  <SortableTh label="难度" k="difficulty" sort={sort} order={order} onToggle={toggleSort} />
                  <SortableTh label="到期" k="due" sort={sort} order={order} onToggle={toggleSort} />
                  <th className="px-4 py-2.5 font-medium">挂起</th>
                  <th className="px-4 py-2.5 font-medium">删除</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-border/40 ${rowClass(r)}`}>
                    <td className="max-w-[16rem] truncate px-4 py-2" title={r.question}>
                      {r.question}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{r.deck_name}</td>
                    <td className="px-4 py-2">
                      <Badge className={STATE_BADGE[r.state] ?? ''}>
                        {STATE_LABELS[r.state] ?? `state ${r.state}`}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 tabular-nums">{r.stability.toFixed(2)}</td>
                    <td className="px-4 py-2 tabular-nums">{r.difficulty.toFixed(2)}</td>
                    <td className="whitespace-nowrap px-4 py-2">{fmtDue(r.due)}</td>
                    <td className="px-4 py-2">
                      {r.suspended ? (
                        <Badge className="border-transparent bg-amber-100 text-amber-700">挂起</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {r.deleted ? (
                        <Badge className="border-transparent bg-red-100 text-red-700">删除</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {loading && rows.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">加载中…</div>
            )}
            {!loading && rows.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">没有符合条件的卡片</div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* pagination footer */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          共 {total} 张 · 已显示 {rows.length}
        </span>
        {hasMore && (
          <Button size="sm" variant="outline" onClick={loadMore} disabled={loading}>
            {loading ? '加载中…' : '加载更多'}
          </Button>
        )}
      </div>
    </div>
  )
}
