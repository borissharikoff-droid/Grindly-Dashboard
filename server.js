'use strict'

require('dotenv').config()

const express      = require('express')
const cookieSession = require('cookie-session')
const { createClient } = require('@supabase/supabase-js')
const path = require('path')

// ── Config ───────────────────────────────────────────────────────────────────

const PORT           = process.env.PORT || 3000
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const SESSION_SECRET = process.env.SESSION_SECRET || 'grindly-dashboard-secret-change-me'
const SUPABASE_URL   = process.env.SUPABASE_URL
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[FATAL] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}
if (!ADMIN_PASSWORD) {
  console.error('[FATAL] ADMIN_PASSWORD must be set')
  process.exit(1)
}

// Service-role client — bypasses RLS, only used server-side
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

// ── App ───────────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cookieSession({
  name:   'grindly_admin',
  keys:   [SESSION_SECRET],
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  secure: false, // Railway terminates TLS before Node sees the request
}))

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session?.authed) return next()
  res.status(401).json({ error: 'Unauthorized' })
}

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post('/login', (req, res) => {
  const { password } = req.body
  if (password && password === ADMIN_PASSWORD) {
    req.session.authed = true
    return res.json({ ok: true })
  }
  res.status(403).json({ error: 'Wrong password' })
})

app.post('/logout', (req, res) => {
  req.session = null
  res.json({ ok: true })
})

app.get('/me', (req, res) => {
  res.json({ authed: Boolean(req.session?.authed) })
})

// ── API routes (protected) ────────────────────────────────────────────────────

// Helper: run a raw SQL query via Supabase RPC (we use .rpc or .from chains)
// Since we can't run arbitrary SQL via the JS client, we use .from() queries.

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const [
      totalUsersRes,
      dauRes,
      topEventsRes,
      tabClicksRes,
      sessionsPerDayRes,
      recentUsersRes,
      eventsTodayRes,
      sessionsTodayRes,
    ] = await Promise.all([
      // Total registered users
      supabase.from('profiles').select('id', { count: 'exact', head: true }),

      // DAU: daily distinct users from analytics_events (last 30 days)
      supabase.rpc('admin_dau_30d'),

      // Top event names
      supabase.rpc('admin_top_events', { lim: 20 }),

      // Tab clicks breakdown
      supabase.rpc('admin_tab_clicks'),

      // Sessions per day (last 30 days) from session_summaries
      supabase.rpc('admin_sessions_per_day'),

      // Recent users
      supabase
        .from('profiles')
        .select('username, level, xp, updated_at, is_online')
        .order('updated_at', { ascending: false })
        .limit(60),

      // Events today
      supabase
        .from('analytics_events')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),

      // Sessions today
      supabase
        .from('session_summaries')
        .select('id', { count: 'exact', head: true })
        .gte('start_time', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
    ])

    res.json({
      totalUsers:     totalUsersRes.count ?? 0,
      dau:            dauRes.data  ?? [],
      topEvents:      topEventsRes.data  ?? [],
      tabClicks:      tabClicksRes.data  ?? [],
      sessionsPerDay: sessionsPerDayRes.data ?? [],
      recentUsers:    recentUsersRes.data ?? [],
      eventsToday:    eventsTodayRes.count ?? 0,
      sessionsToday:  sessionsTodayRes.count ?? 0,
    })
  } catch (err) {
    console.error('/api/stats error', err)
    res.status(500).json({ error: String(err) })
  }
})

// Announcements list
app.get('/api/announcements', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('announcements')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Create announcement
app.post('/api/announcements', requireAuth, async (req, res) => {
  const { title, body, icon, expires_at } = req.body
  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: 'title and body are required' })
  }
  const row = { title: title.trim(), body: body.trim(), icon: icon?.trim() || '📢' }
  if (expires_at) row.expires_at = expires_at
  const { data, error } = await supabase.from('announcements').insert(row).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Delete announcement
app.delete('/api/announcements/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('announcements').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// ── Static files ──────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')))

// Catch-all: serve index.html for any unknown routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Grindly admin dashboard running on port ${PORT}`)
})
