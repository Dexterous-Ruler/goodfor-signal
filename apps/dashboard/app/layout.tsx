import './globals.css'
import type { ReactNode } from 'react'
import { Inter_Tight, Inter, JetBrains_Mono } from 'next/font/google'
import Sidebar from '@/components/Sidebar'
import TopStrip from '@/components/TopStrip'

const display = Inter_Tight({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-display', display: 'swap' })
const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' })
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono', display: 'swap' })

export const metadata = {
  title: 'Goodfor Signal',
  description: 'TikTok competitor intelligence, publishing, attribution and creator CRM',
}

// Set the saved theme before first paint to avoid a flash. Default: light (matches the sober references).
const themeScript = `try{var t=localStorage.getItem('theme')||'light';document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <div className="app">
          <Sidebar />
          <div className="main">
            <TopStrip />
            {children}
          </div>
        </div>
      </body>
    </html>
  )
}
