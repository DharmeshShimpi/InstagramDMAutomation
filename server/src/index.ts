import express from 'express'
import { IgApiClient } from 'instagram-private-api'
import dotenv from 'dotenv'
import { setTimeout as delay } from 'timers/promises'
import { fetch } from 'undici'

dotenv.config()

const app = express()
app.use(express.json({ limit: '1mb' }))

// Job state (in-memory)
interface JobState {
  running: boolean
  igUser?: string
  total: number
  index: number
  sent: number
  failed: number
  currentUsername?: string
  currentProxy?: string
  userAgent?: string
  nextSendAt?: number // epoch ms
  lastError?: string
  lastStep?: string
}

function sanitizeMessage(msg: string, name: string, username: string): string {
  let out = msg.trim()
  // Replace common placeholders with actual name/username
  const fallback = name || username
  out = out
    .replace(/\[(?:Name|name|Your Name\/Brand|your name|brand|Brand)\]/g, fallback)
    .replace(/\{(?:name|Name)\}/g, fallback)
    .replace(/<\s*name\s*>/gi, fallback)
  // Remove markdown-like formatting chars and code fences
  out = out.replace(/[\*`_>#]/g, '')
  // Remove leftover square/angle brackets around words
  out = out.replace(/[\[\]<>]/g, '')
  // Collapse excessive whitespace and line breaks
  out = out.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\s{2,}/g, ' ')
  // Trim again
  out = out.trim()
  return out
}

let state: JobState = {
  running: false,
  total: 0,
  index: 0,
  sent: 0,
  failed: 0,
}

function jitterSeconds() {
  // 3–7 minutes in seconds
  const min = 180
  const max = 420
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function captchaExtraDelaySeconds() {
  // 60–120 seconds extra delay to simulate CAPTCHA or human friction
  const min = 60
  const max = 120
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function isValidProxy(p: string): boolean {
  try {
    const u = new URL(p)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !!u.port
  } catch {
    return false
  }
}

async function openrouterGenerate(apiKey: string, systemPrompt: string, username: string, name: string): Promise<string> {
  const model = 'nvidia/nemotron-nano-9b-v2:free'
  const body = {
    model,
    temperature: 0.9,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Write a short, personalized DM for Instagram user @${username} named ${name || 'there'}. Keep it human, specific, and useful. No asterisks, no brackets, no markdown.` },
    ],
  }
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  }
  const url = 'https://openrouter.ai/api/v1/chat/completions'
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) {
    throw new Error(`OpenRouter failed with status ${res.status}`)
  }
  const json = await res.json() as any
  const content: string | undefined = json?.choices?.[0]?.message?.content
  if (!content) throw new Error('OpenRouter returned no content')
  return content
}

app.post('/api/start', async (req: express.Request, res: express.Response) => {
  try {
    if (state.running) return res.status(400).json({ error: 'Job already running' })

    const {
      igUsername,
      igPassword,
      systemPrompt,
      usernames,
      proxies,
      userAgent,
      preferredModel,
    }: {
      igUsername: string
      igPassword: string
      systemPrompt: string
      usernames: string[]
      proxies?: string[]
      userAgent?: string
      preferredModel?: string
    } = req.body

    if (!igUsername || !igPassword || !systemPrompt || !Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
    if (!OPENROUTER_API_KEY) {
      return res.status(400).json({ error: 'Missing OPENROUTER_API_KEY in environment' })
    }

    // Initialize IG client
    const ig = new IgApiClient()
    if (userAgent) {
      ig.state.generateDevice(userAgent)
    } else {
      ig.state.generateDevice(igUsername)
    }

    await ig.account.login(igUsername, igPassword)

    // Prepare job state
    state = {
      running: true,
      igUser: igUsername,
      total: usernames.length,
      index: 0,
      sent: 0,
      failed: 0,
      currentProxy: undefined,
      userAgent,
      nextSendAt: undefined,
      lastError: undefined,
      lastStep: 'login_success',
    }

    // Process in background; do not block response
    ;(async () => {
      // Model fixed to nvidia/nemotron-nano-9b-v2:free (handled in openrouterGenerate)
      try {
        let proxyIndex = 0
        const proxyList = Array.isArray(proxies) ? proxies.filter((p) => typeof p === 'string' && isValidProxy(p)) : []
        for (let i = 0; i < usernames.length; i++) {
          if (!state.running) break
          state.index = i
          const uname = usernames[i]
          state.currentUsername = uname

          try {
            // Round-robin proxy rotation per send
            if (proxyList.length > 0) {
              const current = proxyList[proxyIndex % proxyList.length]
              state.currentProxy = current
              ig.state.proxyUrl = current
              proxyIndex++
            } else {
              state.currentProxy = undefined
              ig.state.proxyUrl = undefined as any
            }
            state.lastStep = 'resolve_user_pk'
            const user = await ig.user.searchExact(uname)
            const pk = user.pk

            state.lastStep = 'generate_message'
            const name = (user as any)?.full_name || ''
            const messageRaw = await openrouterGenerate(OPENROUTER_API_KEY, systemPrompt, uname, name)
            const message = sanitizeMessage(messageRaw, name, uname)

            state.lastStep = 'send_dm'
            const thread = ig.entity.directThread([pk.toString()])
            await thread.broadcastText(message)

            state.sent += 1
            state.lastError = undefined
          } catch (err) {
            state.failed += 1
            state.lastError = err instanceof Error ? err.message : String(err)
          }

          if (i < usernames.length - 1) {
            const base = 3600 // 1 hour seconds
            const jitter = jitterSeconds()
            // CAPTCHA delay simulation: 20% chance, add 60–120s
            const captchaExtra = Math.random() < 0.2 ? captchaExtraDelaySeconds() : 0
            const waitSec = base + jitter + captchaExtra
            const target = Date.now() + waitSec * 1000
            state.nextSendAt = target
            // Countdown loop in 1s steps to keep status responsive
            while (Date.now() < target && state.running) {
              await delay(1000)
            }
          }
        }
      } finally {
        state.running = false
        state.currentUsername = undefined
        state.nextSendAt = undefined
      }
    })()

    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Unknown error' })
  }
})

app.get('/api/status', (_req: express.Request, res: express.Response) => {
  const now = Date.now()
  const secondsRemaining = state.nextSendAt ? Math.max(Math.ceil((state.nextSendAt - now) / 1000), 0) : 0
  res.json({
    running: state.running,
    igUser: state.igUser,
    total: state.total,
    index: state.index,
    sent: state.sent,
    failed: state.failed,
    currentUsername: state.currentUsername,
    currentProxy: state.currentProxy,
    userAgent: state.userAgent,
    secondsRemaining,
    nextSendAt: state.nextSendAt || null,
    lastError: state.lastError || null,
    lastStep: state.lastStep || null,
  })
})

const PORT = Number(process.env.PORT || 5174)
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})
