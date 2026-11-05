'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { BarChart3, LayoutGrid, List, LogOut, Menu, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** Shared top navigation bar with a hamburger menu.
 *  Menu entries live here so future pages (e.g. analytics) plug in easily. */
export function AppHeader() {
  const router = useRouter()

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.replace('/login')
  }

  return (
    <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border/60 bg-card/80 px-4 py-2.5 backdrop-blur">
      <Link href="/" className="text-sm font-bold tracking-wide">
        FSRS Review
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="菜单">
            <Menu className="h-5 w-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel>导航</DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <Link href="/">
              <LayoutGrid className="h-4 w-4" />
              选择 Deck
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/analytics">
              <BarChart3 className="h-4 w-4" />
              数据分析
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/cards">
              <List className="h-4 w-4" />
              全部卡片
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <Settings className="h-4 w-4" />
              全局设置
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => logout()}
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
