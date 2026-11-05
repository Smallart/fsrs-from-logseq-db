'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Plus, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AppHeader } from '@/components/app-header'

type DeckStats = { new: number; learning: number; review: number; total: number }

type Deck = {
  id: number
  name: string
  logseq_uuid: string | null
  tag_name: string | null
  desk_name: string | null
  fsrs: unknown
  card_limit: unknown
  p_due: number
  stats: DeckStats
}

type TagOption = { uuid: string; title: string }

const selectCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring'

export default function HomePage() {
  const [decks, setDecks] = useState<Deck[]>([])
  const [loading, setLoading] = useState(true)

  // add-deck dialog state
  const [showAdd, setShowAdd] = useState(false)
  const [tags, setTags] = useState<TagOption[]>([])
  const [tagUuid, setTagUuid] = useState('')
  const [deskName, setDeskName] = useState('')
  const [creating, setCreating] = useState(false)
  const [addError, setAddError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await fetch('/api/decks').then((r) => r.json())
      setDecks(d?.decks ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function openAdd() {
    setShowAdd(true)
    setAddError('')
    setTagUuid('')
    setDeskName('')
    try {
      const t = await fetch('/api/tags').then((r) => r.json())
      setTags(t?.tags ?? [])
    } catch (e: any) {
      setAddError(e?.message ?? '获取 tags 失败')
    }
  }

  // dropdown: exclude tags already used as decks + the base #card tag
  const usedUuids = new Set(decks.map((d) => d.logseq_uuid).filter(Boolean))
  const availableTags = tags.filter(
    (t) => !usedUuids.has(t.uuid) && t.title.toLowerCase() !== 'card',
  )

  async function createDeck() {
    if (!tagUuid) {
      setAddError('请选择 tag')
      return
    }
    const tag = tags.find((t) => t.uuid === tagUuid)
    if (!tag) {
      setAddError('tag 不存在')
      return
    }
    setCreating(true)
    setAddError('')
    try {
      const res = await fetch('/api/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagUuid, tagName: tag.title, deskName }),
      })
      const d = await res.json()
      if (!res.ok) {
        // validation failure: inline message, dialog stays open (no redirect)
        setAddError(d?.error ?? '创建失败')
        return
      }
      setShowAdd(false)
      await load()
    } catch (e: any) {
      setAddError(e?.message ?? '创建失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="min-h-screen">
      <AppHeader />
      <div className="mx-auto w-full max-w-xl space-y-4 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">选择 Deck</h1>
          <Button
            variant="ghost"
            size="icon"
            onClick={load}
            disabled={loading}
            aria-label="刷新"
            className="text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {loading && decks.length === 0 && (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">加载中…</CardContent>
          </Card>
        )}

        <div className="space-y-3">
          {decks.map((d) => (
            <Link key={d.id} href={`/review?deck=${d.id}`} className="block">
              <Card className="group cursor-pointer transition-colors hover:border-primary/40 hover:bg-accent/40">
                <CardContent className="flex items-center justify-between p-5">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">
                      {d.desk_name ?? d.name}
                      <span className="ml-1 text-sm font-normal text-muted-foreground">（共 {d.stats.total}）</span>
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <Badge className="border-transparent bg-blue-100 text-blue-700">新卡 {d.stats.new}</Badge>
                      <Badge className="border-transparent bg-emerald-100 text-emerald-700">复习 {d.stats.review}</Badge>
                      <Badge className="border-transparent bg-amber-100 text-amber-700">学习中 {d.stats.learning}</Badge>
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        {!loading && decks.length === 0 && (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              暂无 deck，请先到全局设置配置凭证并同步
            </CardContent>
          </Card>
        )}
      </div>

      {/* floating add-deck button pinned to the viewport bottom */}
      <Button
        onClick={openAdd}
        className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full px-5 py-3 shadow-lg"
      >
        <Plus className="h-4 w-4" />
        添加 Deck
      </Button>

      {/* add-deck dialog: inline error message on validation failure, no redirect */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !creating && setShowAdd(false)}
        >
          <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <CardContent className="space-y-4 p-6">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">添加 Deck</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowAdd(false)}
                  disabled={creating}
                  aria-label="关闭"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="space-y-1.5">
                <Label>Tag</Label>
                <select className={selectCls} value={tagUuid} onChange={(e) => setTagUuid(e.target.value)}>
                  <option value="">选择 tag…</option>
                  {availableTags.map((t) => (
                    <option key={t.uuid} value={t.uuid}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label>Deck 名称</Label>
                <Input
                  placeholder="留空则使用 tag 名"
                  value={deskName}
                  onChange={(e) => setDeskName(e.target.value)}
                />
              </div>

              {addError && <div className="text-sm text-destructive">{addError}</div>}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowAdd(false)} disabled={creating}>
                  取消
                </Button>
                <Button onClick={createDeck} disabled={creating}>
                  {creating ? '创建中…' : '创建'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
