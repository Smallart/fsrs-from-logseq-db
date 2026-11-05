import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'FSRS Review',
  description: 'Spaced repetition from Logseq #card blocks',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  )
}
