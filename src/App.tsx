import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

function classNames(...cls: (string | false | undefined)[]) {
  return cls.filter(Boolean).join(' ')
}

function formatHMS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(sec)}`
}

export default function App() {
  // Theme toggle
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme') as 'light' | 'dark' | null
    if (saved) return saved
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    return prefersDark ? 'dark' : 'light'
  })
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
    localStorage.setItem('theme', theme)
  }, [theme])

  // Login form state
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  // Prompt editor
  const [systemPrompt, setSystemPrompt] = useState(
    'You are an SDR for a performance marketing agency doing Instagram outreach.\n' +
    '- Goal: Start a warm, specific conversation that leads to a brief discovery chat.\n' +
    '- Personalization: Use the recipient\'s first name (infer from full name if available, otherwise from username by splitting on non-letters and taking the first part capitalized).\n' +
    '- Style: Natural, human, friendly, credible. Zero fluff. No markdown, no asterisks, no brackets, no placeholders.\n' +
    '- Length: 1–2 short sentences. Max 300 characters.\n' +
    '- Content: Reference something plausible about their niche (from name/handle if that\'s all you have). Offer a specific, low-effort value (e.g., 1 quick idea tailored to them).\n' +
    '- CTA: Ask a simple yes/no or either/or question.\n' +
    'Output only the final message text.\n'
  )

  // Usernames import
  const [usernames, setUsernames] = useState<string[]>([])
  const [invalidLines, setInvalidLines] = useState<number[]>([])

  // Metrics
  const [sent, setSent] = useState(0)
  const [failed, setFailed] = useState(0)
  const total = usernames.length
  const remaining = Math.max(total - (sent + failed), 0)
  const percent = total ? Math.round(((sent + failed) / total) * 100) : 0

  // Proxy list and UA
  const [proxies, setProxies] = useState<string[]>([])
  const userAgent = navigator.userAgent

  // Model preference removed (backend fixed model)

  // Backend job tracking
  const [running, setRunning] = useState(false)
  const [secondsRemaining, setSecondsRemaining] = useState(0)

  // File handling
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const proxyFileInputRef = useRef<HTMLInputElement | null>(null)
  const onPickFile = useCallback(() => fileInputRef.current?.click(), [])
  const onPickProxyFile = useCallback(() => proxyFileInputRef.current?.click(), [])
  const onFileChange: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const lines = text.split(/\r?\n/)
    const clean: string[] = []
    const invalid: number[] = []
    for (let i = 0; i < lines.length; i++) {
      const raw = (lines[i] ?? '').trim()
      if (!raw) continue
      const name = raw.startsWith('@') ? raw.slice(1) : raw
      const valid = /^[a-z0-9._]+$/i.test(name)
      if (valid) clean.push(name)
      else invalid.push(i + 1)
    }
    setUsernames(clean)
    setInvalidLines(invalid)
    // Reset metrics on new import
    setSent(0)
    setFailed(0)
  }

  const onProxyFileChange: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const lines = text.split(/\r?\n/)
    const clean: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const raw = (lines[i] ?? '').trim()
      if (!raw) continue
      clean.push(raw)
    }
    setProxies(clean)
  }

  // ETA estimate based on 1-hour intervals (UI-only placeholder)
  const eta = useMemo(() => {
    // Assume 1 DM per interval (1 hour). Remaining hours = remaining.
    // Display in human-readable h m format.
    const hours = remaining
    const days = Math.floor(hours / 24)
    const remH = hours % 24
    const parts: string[] = []
    if (days) parts.push(`${days}d`)
    if (remH || parts.length === 0) parts.push(`${remH}h`)
    return parts.join(' ')
  }, [remaining])

  // Start Automation (UI only in Phase 1)
  const onStart = useCallback(async () => {
    if (!username || !password) {
      alert('Enter Instagram username and password to proceed.')
      return
    }
    if (total === 0) {
      alert('Import a .txt file with usernames first.')
      return
    }
    // reset metrics
    setSent(0)
    setFailed(0)
    try {
      const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          igUsername: username,
          igPassword: password,
          systemPrompt,
          usernames,
          proxies,
          userAgent,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `Start failed (${res.status})`)
      }
      setRunning(true)
    } catch (e: any) {
      alert(e?.message || 'Failed to start job')
    }
  }, [password, proxies, systemPrompt, total, userAgent, username, usernames])

  // Poll backend status when running
  useEffect(() => {
    if (!running) return
    let active = true
    const id = setInterval(async () => {
      try {
        const res = await fetch('/api/status')
        if (!res.ok) return
        const j = await res.json()
        if (!active) return
        setSent(j.sent || 0)
        setFailed(j.failed || 0)
        setSecondsRemaining(j.secondsRemaining || 0)
        // reflect current proxy from backend
        if (j.currentProxy) {
          // no local state needed beyond display; stored in j
        }
        if (!j.running) {
          setRunning(false)
        }
      } catch {}
    }, 1000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [running])

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="sticky top-0 z-10 border-b border-gray-200/60 bg-white/75 backdrop-blur dark:border-gray-800/60 dark:bg-gray-900/75">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <svg className="h-8 w-8 text-brand-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="4"/>
              <path d="M8 12h4M8 16h8M8 8h8"/>
            </svg>
            <h1 className="text-lg font-semibold">Instagram DM Automation</h1>
          </div>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm shadow-sm hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-800"
            aria-label="Toggle theme"
          >
            <span className="h-4 w-4">
              {theme === 'dark' ? (
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><path d="M21.64 13.03A9 9 0 1111 2.36 7 7 0 1021.64 13.03z"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><path d="M6.76 4.84l-1.8-1.79L3.17 4.84l1.79 1.8 1.8-1.8zM1 13h3v-2H1v2zm10 10h2v-3h-2v3zM4.22 19.78l1.8 1.8 1.79-1.8-1.8-1.79-1.79 1.79zM20 11v2h3v-2h-3zM17.24 4.84l1.8-1.79 1.79 1.79-1.8 1.8-1.79-1.8zM12 1h-2v3h2V1zm7.78 18.78l-1.8-1.79-1.79 1.79 1.8 1.8 1.79-1.8z"/></svg>
              )}
            </span>
            <span className="hidden sm:inline">{theme === 'dark' ? 'Dark' : 'Light'} mode</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="grid gap-6 md:grid-cols-3">
          {/* Left column */}
          <div className="md:col-span-2 space-y-6">
            {/* Credentials Card */}
            <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold">Instagram Login</h2>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">Credentials stored in memory only</span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium">Username</label>
                  <input
                    type="text"
                    className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 dark:border-gray-700 dark:bg-gray-950"
                    placeholder="your_instagram_username"
                    value={username}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUsername(e.target.value)}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Password</label>
                  <input
                    type="password"
                    className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 dark:border-gray-700 dark:bg-gray-950"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                  />
                </div>
              </div>
            </section>

            {/* Import + Prompt Card */}
            <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold">Recipients & Prompt</h2>
                <div className="flex items-center gap-2">
                  <input ref={fileInputRef} type="file" accept=".txt" className="hidden" onChange={onFileChange} />
                  <button onClick={onPickFile} className="inline-flex items-center rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow hover:bg-brand-700">Upload .txt</button>
                  <span className="text-xs text-gray-500 dark:text-gray-400">One username per line, no @</span>
                </div>
              </div>

              <div className="mb-4">
                <label className="mb-1 block text-sm font-medium">AI System Prompt</label>
                <textarea
                  className="min-h-[160px] w-full resize-y rounded-md border border-gray-300 bg-white p-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 dark:border-gray-700 dark:bg-gray-950"
                  value={systemPrompt}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setSystemPrompt(e.target.value)}
                />
              </div>

              

              {invalidLines.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200">
                  <p className="text-sm">Ignored invalid usernames on lines: {invalidLines.join(', ')}</p>
                </div>
              )}

              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm text-gray-600 dark:text-gray-400">Imported: <span className="font-semibold text-gray-900 dark:text-gray-100">{total}</span></div>
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  {!running && (
                    <button onClick={onStart} className="inline-flex w-full items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow hover:bg-black sm:w-auto dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">Start Automation</button>
                  )}
                  {running && (
                    <button onClick={async () => {
                      try {
                        const r = await fetch('/api/stop', { method: 'POST' })
                        if (!r.ok) throw new Error('Failed to stop')
                        setRunning(false)
                      } catch (e: any) {
                        alert(e?.message || 'Failed to stop job')
                      }
                    }} className="inline-flex w-full items-center justify-center rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-red-700 sm:w-auto">Stop</button>
                  )}
                </div>
              </div>
            </section>
          </div>

          {/* Right column: Metrics */}
          <aside className="space-y-6">
            <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <h2 className="mb-4 text-base font-semibold">Real-time Metrics</h2>

              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Total Users</span>
                  <span className="font-semibold">{total}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Sent</span>
                  <span className="rounded bg-green-100 px-2 py-0.5 text-green-700 dark:bg-green-900/40 dark:text-green-200">{sent}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Failed</span>
                  <span className="rounded bg-red-100 px-2 py-0.5 text-red-700 dark:bg-red-900/40 dark:text-red-200">{failed}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Remaining</span>
                  <span className="font-semibold">{remaining}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Time left</span>
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-800 dark:bg-gray-800 dark:text-gray-200">{formatHMS(secondsRemaining)}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
                  <div
                    className={classNames(
                      'h-full bg-brand-600 transition-all',
                    )}
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Progress</span>
                  <span className="font-semibold">{percent}%</span>
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <h2 className="mb-4 text-base font-semibold">Network & Identity</h2>
              <div className="space-y-4 text-sm">
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label className="block text-sm font-medium">Proxies (.txt upload)</label>
                    <span className="text-xs text-gray-500 dark:text-gray-400">{proxies.length} loaded</span>
                  </div>
                  <input ref={proxyFileInputRef} type="file" accept=".txt" className="hidden" onChange={onProxyFileChange} />
                  <button onClick={onPickProxyFile} className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-950 dark:hover:bg-gray-900">Upload proxies.txt</button>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">User-Agent</label>
                  <div className="rounded-md border border-gray-200 bg-gray-50 p-2 text-xs text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
                    <code className="break-words">{userAgent}</code>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Current Proxy (live)</label>
                  <div className="rounded-md border border-gray-200 bg-gray-50 p-2 text-xs text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
                    <LiveCurrentProxy />
                  </div>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-8 pt-4 text-center text-xs text-gray-500 dark:text-gray-400">
        This tool is provided for educational and research purposes only. Use responsibly and in accordance with Instagram's Terms of Use and applicable laws. Automated messaging can trigger platform safeguards and may result in temporary or permanent account restrictions or bans. You assume all risk. The maker and contributors are not responsible or liable for any actions taken with this software or any resulting consequences, losses, or damages.
      </footer>
    </div>
  )
}

// Helper component to fetch and show current proxy without extra state wiring
function LiveCurrentProxy() {
  const [cur, setCur] = useState<string>('')
  useEffect(() => {
    let mounted = true
    const id = setInterval(async () => {
      try {
        const r = await fetch('/api/status')
        if (!r.ok) return
        const j = await r.json()
        if (mounted) setCur(j.currentProxy || '')
      } catch {}
    }, 2000)
    return () => { mounted = false; clearInterval(id) }
  }, [])
  return <code className="break-words">{cur || '—'}</code>
}
