'use strict'
// v2
require('dotenv').config()

const express       = require('express')
const cookieSession = require('cookie-session')
const { createClient } = require('@supabase/supabase-js')
const path = require('path')

// ── Config ────────────────────────────────────────────────────────────────────

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

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

// ── App setup ─────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: false, limit: '10mb' }))
app.use(cookieSession({
  name:   'grindly_admin',
  keys:   [SESSION_SECRET],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  secure: false, // Railway terminates TLS before reaching Node
}))

// ── Cache ─────────────────────────────────────────────────────────────────────

const _cache = new Map()

async function cached(key, ttlMs, fn) {
  const now = Date.now()
  const hit = _cache.get(key)
  if (hit && hit.expires > now) return hit.data
  const data = await fn()
  _cache.set(key, { data, expires: now + ttlMs })
  return data
}

function invalidate(key) { _cache.delete(key) }

// ── Supabase helpers ──────────────────────────────────────────────────────────

// Matches the client-side ONLINE_STALE_MS in useFriends.ts
const ONLINE_STALE_MS = 3 * 60 * 1000

async function rpc(name, params = {}) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    console.warn(`[rpc] ${name} →`, error.message)
    return []
  }
  return data ?? []
}

async function count(table, filter = {}) {
  let q = supabase.from(table).select('id', { count: 'exact', head: true })
  for (const [col, val] of Object.entries(filter)) q = q.eq(col, val)
  const { count: n, error } = await q
  if (error) { console.warn(`[count] ${table} →`, error.message); return 0 }
  return n ?? 0
}

// Count users with is_online=true AND updated_at fresh within ONLINE_STALE_MS.
// This mirrors the client-side isFreshOnlinePresence() logic so stale flags
// (from crashes / force-quits that skipped beforeunload) are excluded.
async function countOnline() {
  const staleThreshold = new Date(Date.now() - ONLINE_STALE_MS).toISOString()
  const { count: n, error } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('is_online', true)
    .gte('updated_at', staleThreshold)
  if (error) { console.warn('[countOnline]', error.message); return 0 }
  return n ?? 0
}

async function countWhere(table, col, gte, lt) {
  let q = supabase.from(table).select('id', { count: 'exact', head: true }).gte(col, gte)
  if (lt) q = q.lt(col, lt)
  const { count: n, error } = await q
  if (error) { console.warn(`[countWhere] ${table} →`, error.message); return 0 }
  return n ?? 0
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session?.authed) return next()
  res.status(401).json({ error: 'Unauthorized' })
}

app.post('/login', (req, res) => {
  if (req.body.password && req.body.password === ADMIN_PASSWORD) {
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

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    if (req.query.force === '1') invalidate('stats')
    // onlineNow is a live metric — fetch fresh every 30 s, not with the 5-min cache.
    const onlineNow = await cached('online_now', 30 * 1000, countOnline)

    const data = await cached('stats', 5 * 60 * 1000, async () => {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
      const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1)

      const [
        totalUsers,
        dau,
        userGrowth,
        sessionsPerDay,
        sessionStatsArr,
        topEvents,
        tabClicks,
        hourlyActivity,
        featureAdoption,
        skillBreakdown,
        levelDistribution,
        streakStatsArr,
        eventsToday,
        eventsYesterday,
        sessionsToday,
        sessionsYesterday,
      ] = await Promise.all([
        count('profiles'),
        rpc('admin_dau_30d'),
        rpc('admin_user_growth_30d'),
        rpc('admin_sessions_per_day'),
        rpc('admin_session_stats'),
        rpc('admin_top_events', { lim: 15 }),
        rpc('admin_tab_clicks'),
        rpc('admin_hourly_activity'),
        rpc('admin_feature_adoption'),
        rpc('admin_skill_breakdown'),
        rpc('admin_level_distribution'),
        rpc('admin_streak_stats'),
        countWhere('analytics_events', 'created_at', todayStart.toISOString()),
        countWhere('analytics_events', 'created_at', yesterdayStart.toISOString(), todayStart.toISOString()),
        countWhere('session_summaries', 'start_time', todayStart.toISOString()),
        countWhere('session_summaries', 'start_time', yesterdayStart.toISOString(), todayStart.toISOString()),
      ])

      const todayStr     = todayStart.toISOString().slice(0, 10)
      const yesterdayStr = yesterdayStart.toISOString().slice(0, 10)
      const dauToday     = Number((dau || []).find(r => r.day === todayStr)?.users ?? 0)
      const dauYesterday = Number((dau || []).find(r => r.day === yesterdayStr)?.users ?? 0)

      return {
        totalUsers,
        dau,
        userGrowth,
        sessionsPerDay,
        sessionStats:      sessionStatsArr[0] ?? {},
        topEvents,
        tabClicks,
        hourlyActivity,
        featureAdoption,
        skillBreakdown,
        levelDistribution,
        streakStats:       streakStatsArr[0] ?? {},
        eventsToday,
        eventsYesterday,
        sessionsToday,
        sessionsYesterday,
        dauToday,
        dauYesterday,
      }
    })
    res.json({ ...data, onlineNow })
  } catch (err) {
    console.error('/api/stats', err)
    res.status(500).json({ error: String(err) })
  }
})

// ── Users ─────────────────────────────────────────────────────────────────────

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const search     = String(req.query.search ?? '').trim()
    const onlineOnly = req.query.online === '1'
    const lim        = Math.min(parseInt(req.query.limit ?? '150', 10) || 150, 500)
    const sortParam  = req.query.sort   // level | streak | username | last_seen
    const ascending  = req.query.order === 'asc'
    const sortCol    = sortParam === 'level'    ? 'level'
                     : sortParam === 'streak'   ? 'streak_count'
                     : sortParam === 'username' ? 'username'
                     : 'updated_at'
    let q = supabase
      .from('profiles')
      .select('id, username, level, xp, is_online, current_activity, streak_count, updated_at')
      .order(sortCol, { ascending })
      .limit(lim)
    if (search)     q = q.ilike('username', `%${search}%`)
    if (onlineOnly) q = q.eq('is_online', true)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    res.json(data ?? [])
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ── Announcements ─────────────────────────────────────────────────────────────

app.get('/api/announcements', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('announcements')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return res.status(500).json({ error: error.message })
  res.json(data ?? [])
})

app.post('/api/announcements', requireAuth, async (req, res) => {
  const { title, body, icon, expires_at } = req.body
  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: 'title and body are required' })
  }
  const row = { title: title.trim(), body: body.trim(), icon: icon?.trim() || '📢' }
  if (expires_at) row.expires_at = expires_at
  const { data, error } = await supabase.from('announcements').insert(row).select().single()
  if (error) return res.status(500).json({ error: error.message })
  invalidate('stats')
  res.json(data)
})

app.delete('/api/announcements/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('announcements').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// ── Admin Game Config ─────────────────────────────────────────────────────────

app.get('/api/admin-config', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('admin_config')
    .select('config')
    .eq('id', 'singleton')
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data?.config ?? {})
})

app.post('/api/admin-config', requireAuth, async (req, res) => {
  const config = req.body
  if (typeof config !== 'object' || Array.isArray(config)) {
    return res.status(400).json({ error: 'config must be a plain object' })
  }
  const { error } = await supabase
    .from('admin_config')
    .upsert({ id: 'singleton', config, updated_at: new Date().toISOString() })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

app.get('/api/economy', requireAuth, async (req, res) => {
  try {
    const [goldRes, holdersRes, listingsRes] = await Promise.all([
      supabase.from('profiles').select('gold'),
      supabase.from('profiles').select('username,gold').order('gold', { ascending: false }).limit(10),
      supabase.from('marketplace_listings').select('price_gold,quantity').eq('status', 'active'),
    ])
    if (goldRes.error) return res.status(500).json({ error: goldRes.error.message })

    const goldArr = (goldRes.data || []).map(r => Number(r.gold) || 0)
    const totalGold = goldArr.reduce((a, b) => a + b, 0)
    const avgGold   = goldArr.length ? totalGold / goldArr.length : 0

    const listings      = listingsRes.data || []
    const activeListings = listings.length
    const listingsValue  = listings.reduce((a, r) => a + (Number(r.price_gold) || 0) * (Number(r.quantity) || 1), 0)

    // Gold distribution buckets
    const buckets = [0, 100, 500, 1000, 5000, 10000, 50000, Infinity]
    const bucketLabels = ['0', '100', '500', '1K', '5K', '10K', '50K+']
    const counts = new Array(bucketLabels.length).fill(0)
    for (const g of goldArr) {
      for (let i = 0; i < buckets.length - 1; i++) {
        if (g >= buckets[i] && g < buckets[i + 1]) { counts[i]++; break }
      }
    }
    const goldBuckets = bucketLabels.map((label, i) => ({ label, count: counts[i] }))

    res.json({
      totalGold,
      avgGold,
      activeListings,
      listingsValue,
      topHolders: holdersRes.data || [],
      goldBuckets,
    })
  } catch (err) {
    console.error('/api/economy', err)
    res.status(500).json({ error: String(err) })
  }
})

// ── Static ────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')))
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

app.listen(PORT, () => console.log(`[grindly-admin] running on port ${PORT}`))
