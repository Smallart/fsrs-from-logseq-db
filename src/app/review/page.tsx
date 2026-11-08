'use client'
import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft, Settings, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

type Card = {
  cid: number
  nid: number
  did: number
  dbId: number | null
  question: string
  state: number
  due: number
} | { empty: true }

type Detail = { cid: number; question: string; answer: string[] }

type Stats = {
  deck: { id: number; name: string }
  boxes: { new: number; learning: number; review: number }
  total: number
}

// ts-fsrs State: 0=New, 1=Learning, 2=Review, 3=Relearning
const STATE_LABELS = ['新卡', '学习中', '复习中', '重新学习']
const stateLabel = (s: number) => STATE_LABELS[s] ?? `state ${s}`

// Anki-style badge colors: New=blue, Learning=orange, Review=green, Relearning=red
const STATE_BADGE: Record<number, string> = {
  0: 'border-transparent bg-blue-100 text-blue-700',
  1: 'border-transparent bg-amber-100 text-amber-700',
  2: 'border-transparent bg-emerald-100 text-emerald-700',
  3: 'border-transparent bg-red-100 text-red-700',
}

// Anki-style cloze rendering: hide {{cloze xxx}} behind a [...] placeholder
// until the answer is shown, then reveal the cloze text as plain text.
function renderQuestion(q: string, showAnswer: boolean): ReactNode[] {
  const re = /\{\{cloze\s*([^}]+)\}\}/g
  const parts: ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(q))) {
    if (m.index > last) parts.push(q.slice(last, m.index))
    if (showAnswer) {
      parts.push(m[1].trim())
    } else {
      parts.push(
        <span
          key={key++}
          className="rounded bg-muted px-1.5 py-0.5 text-sm text-muted-foreground"
        >
          [...]
        </span>,
      )
    }
    last = re.lastIndex
  }
  if (last < q.length) parts.push(q.slice(last))
  return parts
}

function ReviewInner() {
  const searchParams = useSearchParams()
  const deckParam = searchParams.get('deck')
  const deckId = deckParam && Number.isInteger(Number(deckParam)) ? Number(deckParam) : undefined
  const query = deckId ? `?deck=${deckId}` : ''

  const [card, setCard] = useState<Card | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [showAnswer, setShowAnswer] = useState(false)
  const [loading, setLoading] = useState(false)
  const [lastReview, setLastReview] = useState<{ cid: number; lid: number } | null>(null)
  const [error, setError] = useState('')

  const fetchNext = useCallback(async () => {
    setLoading(true)
    setError('')
    setShowAnswer(false)
    setDetail(null)
    try {
      const [cardRes, statsRes] = await Promise.all([
        fetch(`/api/cards/next${query}`),
        fetch(`/api/cards/stats${query}`),
      ])
      setCard((await cardRes.json()) as Card)
      const s = (await statsRes.json()) as Stats
      setStats(s?.deck ? s : null)
    } catch (e: any) {
      setError(e?.message ?? '加载失败')
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => {
    fetchNext()
  }, [fetchNext])

  // Ctrl+Z / Cmd+Z undo last review
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (lastReview && !loading) undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lastReview, loading])

  // 显示答案 → the answer is fetched from the gateway per-card (§4.5) —
  // answers are never stored locally
  async function revealAnswer() {
    if (!card || 'empty' in card) return
    setShowAnswer(true)
    setDetail(null)
    try {
      const res = await fetch(`/api/cards/${card.cid}/detail`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? '获取答案失败')
      setDetail((await res.json()) as Detail)
    } catch (e: any) {
      setError(e?.message ?? '获取答案失败')
    }
  }

  async function grade(g: 1 | 2 | 3 | 4) {
    if (!card || 'empty' in card) return
    setLoading(true)
    try {
      const res = await fetch('/api/cards/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid: card.cid, grade: g }),
      })
      const data = await res.json()
      setLastReview({ cid: card.cid, lid: data.lid })
      await fetchNext()
    } catch (e: any) {
      setError(e?.message ?? '评分失败')
      setLoading(false)
    }
  }

  async function undo() {
    if (!lastReview) return
    setLoading(true)
    try {
      await fetch('/api/cards/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastReview),
      })
      setLastReview(null)
      await fetchNext()
    } catch (e: any) {
      setError(e?.message ?? '撤回失败')
      setLoading(false)
    }
  }

  const settingsDeckId = stats?.deck.id ?? deckId

  return (
    <div className="mx-auto min-h-screen w-full max-w-xl space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Link href="/">
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-4 w-4" />
            返回
          </Button>
        </Link>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={undo}
          disabled={!lastReview || loading}
          className="text-muted-foreground hover:text-foreground"
        >
          <Undo2 className="h-4 w-4" />
          撤回
        </Button>
        {settingsDeckId != null && (
          <Link href={`/deck/${settingsDeckId}/settings`}>
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
              <Settings className="h-4 w-4" />
              设置
            </Button>
          </Link>
        )}
      </div>

      {stats && (
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">{stats.deck.name}</span>
          <div className="flex gap-2">
            <Badge className="border-transparent bg-blue-100 text-blue-700">新卡 {stats.boxes.new}</Badge>
            <Badge className="border-transparent bg-emerald-100 text-emerald-700">复习 {stats.boxes.review}</Badge>
            <Badge className="border-transparent bg-amber-100 text-amber-700">学习中 {stats.boxes.learning}</Badge>
          </div>
        </div>
      )}

      {loading && !card && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">加载中…</CardContent>
        </Card>
      )}

      {card && 'empty' in card && (
        <Card>
          <CardContent className="space-y-3 p-8 text-center">
            <h2 className="text-lg font-semibold">🎉 今日复习完成</h2>
            <p className="text-sm text-muted-foreground">没有更多到期卡片或新卡了。</p>
            <Button onClick={fetchNext} disabled={loading}>
              再检查一次
            </Button>
          </CardContent>
        </Card>
      )}

      {card && !('empty' in card) && (
        <Card className="relative">
          <div className="absolute right-4 top-4">
            <Badge className={STATE_BADGE[card.state] ?? ''}>{stateLabel(card.state)}</Badge>
          </div>
          <CardContent className="flex min-h-[40vh] flex-col justify-center gap-5 p-6">
            <div className="whitespace-pre-wrap text-lg leading-relaxed">
              {renderQuestion(card.question, showAnswer)}
            </div>
            {showAnswer && (
              <>
                <Separator />
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    答案{detail ? '' : '获取中…'}
                  </div>
                  {detail?.answer.length ? (
                    detail.answer.map((a, i) => (
                      <div key={i} className="whitespace-pre-wrap text-base leading-relaxed">
                        {a}
                      </div>
                    ))
                  ) : detail ? (
                    <div className="text-sm text-muted-foreground">（无答案子块）</div>
                  ) : null}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {error && <div className="text-sm text-destructive">{error}</div>}

      {!showAnswer ? (
        <Button
          className="h-14 w-full text-base"
          onClick={revealAnswer}
          disabled={loading || !card || ('empty' in card)}
        >
          显示答案
        </Button>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          <button
            className="h-14 rounded-md bg-destructive text-sm font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => grade(1)}
            disabled={loading}
          >
            重来
          </button>
          <button
            className="h-14 rounded-md bg-amber-500 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => grade(2)}
            disabled={loading}
          >
            困难
          </button>
          <button
            className="h-14 rounded-md bg-emerald-500 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => grade(3)}
            disabled={loading}
          >
            良好
          </button>
          <button
            className="h-14 rounded-md bg-primary text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => grade(4)}
            disabled={loading}
          >
            简单
          </button>
        </div>
      )}
    </div>
  )
}

export default function ReviewPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-muted-foreground">加载中…</div>}>
      <ReviewInner />
    </Suspense>
  )
}
