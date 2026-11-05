'use client'
/**
 * ═══════════════════════════════════════════════════════════════════════
 * revlog 语义速查（做数据分析/统计时必读，别被 Anki 文档误导）
 *
 * 我们用 ts-fsrs（4.7.1），它的 `log` 与 Anki 的 revlog 语义【不同】：
 *   - 我们的 revlog 记录的是【评分前】的状态快照（卡片被呈现那一刻）
 *   - Anki 的 ivl 记录的是【评分后】的新间隔，网上说法多指 Anki
 *
 * 字段对照（ts-fsrs buildLog 源码，`this.current` 尚未被改写为评分后状态）：
 *   revlog.state / stability / difficulty / scheduled_days  → 评分前
 *   revlog.due                                              → 评分前的 last_review（无则评分前 due）
 *   revlog.elapsed_days                                     → 本次评分事件的间隔（距上次复习天数）
 *   revlog.last_elapsed_days                                → 评分前的上次间隔
 *   revlog.rating / review / duration                       → 评分事件本身（评几 / 时间 / 用时）
 *
 * 结论：
 *   - cards 表  = 评分后的【当前状态】（唯一权威源，取卡/评分都读它）
 *   - revlog 表 = 评分前快照 + 事件元数据（历史流，每次评分一条）
 *   - undo 之所以能还原，正因为 revlog 存的是评分前快照（fsrs.rollback 从 log 读回旧值）
 *   - 查「现在什么状态」→ 永远读 cards；查「某次评分前长啥样」→ 读对应 revlog 行
 * ═══════════════════════════════════════════════════════════════════════
 */
import Link from 'next/link'
import { BarChart3, ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

export default function AnalyticsPage() {
  return (
    <div className="mx-auto min-h-screen w-full max-w-xl space-y-4 p-4">
      <Link href="/">
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
          返回
        </Button>
      </Link>
      <h1 className="text-xl font-bold">数据分析</h1>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <BarChart3 className="h-10 w-10 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">数据分析页面开发中，敬请期待</p>
        </CardContent>
      </Card>
    </div>
  )
}
