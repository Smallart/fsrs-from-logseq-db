'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AppHeader } from '@/components/app-header'

type DeckStats = { new: number; learning: number; review: number; total: number }

type Deck = {
  id: number
  name: string
  anchorUuid: string | null
  deskName: string | null
  stats: DeckStats
}

export default function HomePage() {
  const [decks, setDecks] = useState<Deck[]>([])
  const [loading, setLoading] = useState(true)

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
                      {d.deskName ?? d.name}
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

        {!loading && decks.length <= 1 && (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              暂无标签 deck。Deck 由卡片上的 tag 自动生成——到全局设置配置网关地址并同步后，这里会列出所有带卡标签的 deck。
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
