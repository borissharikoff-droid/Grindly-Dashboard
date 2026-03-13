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

// ── Polls ─────────────────────────────────────────────────────────────────────

app.get('/api/polls', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('polls')
    .select('*, poll_options(id, label, sort_order)')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return res.status(500).json({ error: error.message })

  // Attach vote counts per option
  for (const poll of (data ?? [])) {
    const { data: votes } = await supabase
      .from('poll_votes')
      .select('option_id')
      .eq('poll_id', poll.id)
    const counts = {}
    for (const v of (votes ?? [])) counts[v.option_id] = (counts[v.option_id] || 0) + 1
    poll.total_votes = (votes ?? []).length
    for (const opt of (poll.poll_options ?? [])) opt.votes = counts[opt.id] || 0
    poll.poll_options.sort((a, b) => a.sort_order - b.sort_order)
  }
  res.json(data ?? [])
})

app.post('/api/polls', requireAuth, async (req, res) => {
  const { title, description, icon, expires_at, options } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' })
  if (!Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: 'at least 2 options required' })
  }

  const row = { title: title.trim(), description: (description || '').trim(), icon: icon?.trim() || '📊' }
  if (expires_at) row.expires_at = expires_at
  const { data: poll, error } = await supabase.from('polls').insert(row).select().single()
  if (error) return res.status(500).json({ error: error.message })

  const optRows = options.map((label, i) => ({ poll_id: poll.id, label: label.trim(), sort_order: i }))
  const { error: optErr } = await supabase.from('poll_options').insert(optRows)
  if (optErr) return res.status(500).json({ error: optErr.message })

  // Re-fetch with options
  const { data: full } = await supabase
    .from('polls')
    .select('*, poll_options(id, label, sort_order)')
    .eq('id', poll.id)
    .single()
  res.json(full)
})

app.delete('/api/polls/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('polls').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

app.patch('/api/polls/:id/close', requireAuth, async (req, res) => {
  const { error } = await supabase.from('polls').update({ is_active: false }).eq('id', req.params.id)
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
    const data = await cached('economy', 5 * 60 * 1000, async () => {
      const [goldRes, holdersRes, listingsRes, soldRes, tradeRes] = await Promise.all([
        supabase.from('profiles').select('gold'),
        supabase.from('profiles').select('username,gold').order('gold', { ascending: false }).limit(10),
        supabase.from('marketplace_listings').select('price_gold,quantity').eq('status', 'active'),
        supabase.from('marketplace_listings').select('price_gold,quantity,item_id,created_at').eq('status', 'sold'),
        supabase.from('trade_history').select('unit_price,quantity,total_gold,traded_at,item_id').order('traded_at', { ascending: false }).limit(500),
      ])
      if (goldRes.error) throw new Error(goldRes.error.message)

      const goldArr = (goldRes.data || []).map(r => Number(r.gold) || 0)
      const totalGold = goldArr.reduce((a, b) => a + b, 0)
      const avgGold   = goldArr.length ? totalGold / goldArr.length : 0
      const medianGold = goldArr.length ? [...goldArr].sort((a,b) => a - b)[Math.floor(goldArr.length / 2)] : 0
      const maxGold    = goldArr.length ? Math.max(...goldArr) : 0

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

      // Trade volume by day (last 30 days)
      const trades = tradeRes.data || []
      const tradesByDay = {}
      const goldByDay = {}
      for (const t of trades) {
        const day = t.traded_at ? t.traded_at.slice(0, 10) : null
        if (!day) continue
        tradesByDay[day] = (tradesByDay[day] || 0) + (Number(t.quantity) || 0)
        goldByDay[day] = (goldByDay[day] || 0) + (Number(t.total_gold) || 0)
      }
      const tradeVolume30d = []
      for (let i = 29; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i)
        const k = d.toISOString().slice(0, 10)
        tradeVolume30d.push({ day: k, items: tradesByDay[k] || 0, gold: goldByDay[k] || 0 })
      }

      // Most traded items
      const itemVolume = {}
      const itemGoldVolume = {}
      for (const t of trades) {
        itemVolume[t.item_id] = (itemVolume[t.item_id] || 0) + (Number(t.quantity) || 0)
        itemGoldVolume[t.item_id] = (itemGoldVolume[t.item_id] || 0) + (Number(t.total_gold) || 0)
      }
      const topTraded = Object.entries(itemVolume)
        .map(([id, vol]) => ({ item_id: id, volume: vol, gold_volume: itemGoldVolume[id] || 0 }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 10)

      // Total trade stats
      const totalTradeVolume = trades.reduce((a, t) => a + (Number(t.quantity) || 0), 0)
      const totalTradeGold = trades.reduce((a, t) => a + (Number(t.total_gold) || 0), 0)
      const totalSold = (soldRes.data || []).length

      // Gold circulation (Gini coefficient approximation)
      const sorted = [...goldArr].sort((a, b) => a - b)
      let gini = 0
      if (sorted.length > 1 && totalGold > 0) {
        let sumOfDiffs = 0
        for (let i = 0; i < sorted.length; i++) {
          sumOfDiffs += (2 * (i + 1) - sorted.length - 1) * sorted[i]
        }
        gini = Math.round(sumOfDiffs / (sorted.length * totalGold) * 100) / 100
      }

      return {
        totalGold,
        avgGold,
        medianGold,
        maxGold,
        gini,
        activeListings,
        listingsValue,
        totalSold,
        totalTradeVolume,
        totalTradeGold,
        topHolders: holdersRes.data || [],
        goldBuckets,
        tradeVolume30d,
        topTraded,
      }
    })
    res.json(data)
  } catch (err) {
    console.error('/api/economy', err)
    res.status(500).json({ error: String(err) })
  }
})

// ── Player Management ─────────────────────────────────────────────────────────

// Get full player details (skills, inventory, chests, achievements, gold)
app.get('/api/users/:id/details', requireAuth, async (req, res) => {
  try {
    const uid = req.params.id
    const [profileRes, skillsRes, inventoryRes, chestsRes, achievementsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', uid).single(),
      supabase.from('user_skills').select('skill_id, level, total_xp, prestige_count').eq('user_id', uid),
      supabase.from('user_inventory').select('item_id, quantity').eq('user_id', uid).gt('quantity', 0),
      supabase.from('user_chests').select('chest_type, quantity').eq('user_id', uid).gt('quantity', 0),
      supabase.from('user_achievements').select('achievement_id, unlocked_at').eq('user_id', uid),
    ])
    if (profileRes.error) return res.status(404).json({ error: 'User not found' })
    res.json({
      profile: profileRes.data,
      skills: skillsRes.data ?? [],
      inventory: inventoryRes.data ?? [],
      chests: chestsRes.data ?? [],
      achievements: achievementsRes.data ?? [],
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Set skill XP — inserts admin_skill_overrides row (applied on next sync) + updates user_skills directly
app.post('/api/users/:id/skills', requireAuth, async (req, res) => {
  try {
    const uid = req.params.id
    const { skill_id, total_xp, level } = req.body
    if (!skill_id || total_xp == null) return res.status(400).json({ error: 'skill_id and total_xp required' })
    const xp = Math.max(0, Math.floor(Number(total_xp)))
    const lvl = level ?? Math.floor(99 * Math.pow(xp / 3_600_000, 1 / 2.2))

    // Insert override for client to pick up on next sync
    await supabase.from('admin_skill_overrides').insert({ user_id: uid, skill_id, total_xp: xp, level: lvl })
    // Also update user_skills directly so dashboard shows new value
    await supabase.from('user_skills').upsert(
      { user_id: uid, skill_id, total_xp: xp, level: lvl, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,skill_id' }
    )
    // Update profile level to max skill level
    const { data: allSkills } = await supabase.from('user_skills').select('level').eq('user_id', uid)
    if (allSkills?.length) {
      const maxLevel = Math.max(...allSkills.map(s => s.level ?? 0))
      await supabase.from('profiles').update({ level: maxLevel }).eq('id', uid)
    }
    res.json({ ok: true, total_xp: xp, level: lvl })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Reset all skills to 0
app.post('/api/users/:id/reset-skills', requireAuth, async (req, res) => {
  try {
    const uid = req.params.id
    const { data: skills } = await supabase.from('user_skills').select('skill_id').eq('user_id', uid)
    if (skills?.length) {
      for (const s of skills) {
        await supabase.from('admin_skill_overrides').insert({ user_id: uid, skill_id: s.skill_id, total_xp: 0, level: 0 })
        await supabase.from('user_skills').update({ total_xp: 0, level: 0, updated_at: new Date().toISOString() }).eq('user_id', uid).eq('skill_id', s.skill_id)
      }
    }
    await supabase.from('profiles').update({ level: 0 }).eq('id', uid)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Set gold
app.post('/api/users/:id/gold', requireAuth, async (req, res) => {
  try {
    const gold = Math.max(0, Math.floor(Number(req.body.gold ?? 0)))
    const { error } = await supabase.from('profiles').update({ gold }).eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, gold })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Set streak
app.post('/api/users/:id/streak', requireAuth, async (req, res) => {
  try {
    const streak_count = Math.max(0, Math.floor(Number(req.body.streak_count ?? 0)))
    const { error } = await supabase.from('profiles').update({ streak_count }).eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, streak_count })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Grant/set inventory item
app.post('/api/users/:id/inventory', requireAuth, async (req, res) => {
  try {
    const uid = req.params.id
    const { item_id, quantity } = req.body
    if (!item_id || quantity == null) return res.status(400).json({ error: 'item_id and quantity required' })
    const qty = Math.max(0, Math.floor(Number(quantity)))
    if (qty === 0) {
      await supabase.from('user_inventory').delete().eq('user_id', uid).eq('item_id', item_id)
    } else {
      await supabase.from('user_inventory').upsert(
        { user_id: uid, item_id, quantity: qty, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,item_id' }
      )
    }
    res.json({ ok: true, item_id, quantity: qty })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Grant/set chests
app.post('/api/users/:id/chests', requireAuth, async (req, res) => {
  try {
    const uid = req.params.id
    const { chest_type, quantity } = req.body
    if (!chest_type || quantity == null) return res.status(400).json({ error: 'chest_type and quantity required' })
    const qty = Math.max(0, Math.floor(Number(quantity)))
    if (qty === 0) {
      await supabase.from('user_chests').delete().eq('user_id', uid).eq('chest_type', chest_type)
    } else {
      await supabase.from('user_chests').upsert(
        { user_id: uid, chest_type, quantity: qty, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,chest_type' }
      )
    }
    res.json({ ok: true, chest_type, quantity: qty })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Remove achievement
app.delete('/api/users/:id/achievements/:achievementId', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('user_achievements').delete()
      .eq('user_id', req.params.id)
      .eq('achievement_id', req.params.achievementId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Delete user entirely
app.delete('/api/users/:id', requireAuth, async (req, res) => {
  try {
    const uid = req.params.id

    // Verify user exists
    const { data: profile, error: profileErr } = await supabase.from('profiles').select('id, username').eq('id', uid).single()
    if (profileErr || !profile) return res.status(404).json({ error: 'User not found' })

    // Delete from all user-related tables
    await Promise.all([
      supabase.from('user_skills').delete().eq('user_id', uid),
      supabase.from('user_inventory').delete().eq('user_id', uid),
      supabase.from('user_chests').delete().eq('user_id', uid),
      supabase.from('user_achievements').delete().eq('user_id', uid),
      supabase.from('admin_skill_overrides').delete().eq('user_id', uid),
      supabase.from('session_summaries').delete().eq('user_id', uid),
      supabase.from('analytics_events').delete().eq('user_id', uid),
      supabase.from('item_gifts').delete().eq('sender_id', uid),
      supabase.from('item_gifts').delete().eq('receiver_id', uid),
      supabase.from('messages').delete().eq('sender_id', uid),
      supabase.from('messages').delete().eq('receiver_id', uid),
      supabase.from('friendships').delete().eq('user_id', uid),
      supabase.from('friendships').delete().eq('friend_id', uid),
      supabase.from('marketplace_listings').delete().eq('seller_id', uid),
    ])

    // Delete profile
    const { error: delErr } = await supabase.from('profiles').delete().eq('id', uid)
    if (delErr) return res.status(500).json({ error: delErr.message })

    // Delete Supabase auth user
    const { error: authErr } = await supabase.auth.admin.deleteUser(uid)
    if (authErr) console.warn('[delete-user] auth.admin.deleteUser failed:', authErr.message)

    invalidate('stats')
    invalidate('economy')
    res.json({ ok: true, username: profile.username })
  } catch (err) {
    console.error('/api/users/:id DELETE', err)
    res.status(500).json({ error: String(err) })
  }
})

// ── Abuse Detection / User Analytics ─────────────────────────────────────────

app.get('/api/abuse-detection', requireAuth, async (req, res) => {
  try {
    const data = await cached('abuse_detection', 5 * 60 * 1000, async () => {
      const alerts = []
      const now = new Date()
      const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString()
      const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

      // ── 1. XP anomalies: users with extremely high XP in any skill ──
      const { data: xpOutliers } = await supabase
        .from('user_skills')
        .select('user_id, skill_id, total_xp, level, updated_at')
        .gt('total_xp', 1_000_000)
        .order('total_xp', { ascending: false })
        .limit(50)

      // Get profile info for flagged users
      const flaggedUserIds = new Set()
      const userProfileCache = {}

      if (xpOutliers?.length) {
        for (const row of xpOutliers) flaggedUserIds.add(row.user_id)
      }

      // ── 2. Gold anomalies: users with extreme gold ──
      const { data: goldOutliers } = await supabase
        .from('profiles')
        .select('id, username, gold, level, streak_count, updated_at, created_at')
        .order('gold', { ascending: false })
        .limit(20)

      // Calculate gold stats for thresholds
      const { data: allGold } = await supabase.from('profiles').select('gold')
      const goldValues = (allGold || []).map(r => Number(r.gold) || 0)
      const avgGold = goldValues.length ? goldValues.reduce((a, b) => a + b, 0) / goldValues.length : 0
      const goldStdDev = goldValues.length > 1
        ? Math.sqrt(goldValues.reduce((sum, g) => sum + Math.pow(g - avgGold, 2), 0) / goldValues.length)
        : 0
      const goldThreshold = avgGold + 3 * goldStdDev

      if (goldOutliers?.length) {
        for (const u of goldOutliers) {
          if (Number(u.gold) > goldThreshold && goldThreshold > 0) {
            flaggedUserIds.add(u.id)
            alerts.push({
              type: 'gold_anomaly',
              severity: Number(u.gold) > avgGold + 5 * goldStdDev ? 'high' : 'medium',
              user_id: u.id,
              username: u.username,
              detail: `Gold: ${Number(u.gold).toLocaleString()} (avg: ${Math.round(avgGold).toLocaleString()}, threshold: ${Math.round(goldThreshold).toLocaleString()})`,
              value: Number(u.gold),
              timestamp: u.updated_at,
            })
          }
        }
      }

      // ── 3. Session anomalies: extremely long or many sessions ──
      const { data: recentSessions } = await supabase
        .from('session_summaries')
        .select('user_id, start_time, end_time, duration_seconds')
        .gte('start_time', weekAgo)
        .order('duration_seconds', { ascending: false })
        .limit(200)

      if (recentSessions?.length) {
        // Flag sessions over 12h
        for (const s of recentSessions) {
          const dur = Number(s.duration_seconds) || 0
          if (dur > 12 * 3600) {
            flaggedUserIds.add(s.user_id)
            alerts.push({
              type: 'long_session',
              severity: dur > 24 * 3600 ? 'high' : 'medium',
              user_id: s.user_id,
              username: null,
              detail: `Session lasted ${(dur / 3600).toFixed(1)}h (${new Date(s.start_time).toLocaleDateString()})`,
              value: dur,
              timestamp: s.start_time,
            })
          }
        }

        // Count sessions per user in last 7 days
        const sessionsPerUser = {}
        const totalDurPerUser = {}
        for (const s of recentSessions) {
          sessionsPerUser[s.user_id] = (sessionsPerUser[s.user_id] || 0) + 1
          totalDurPerUser[s.user_id] = (totalDurPerUser[s.user_id] || 0) + (Number(s.duration_seconds) || 0)
        }
        for (const [uid, total] of Object.entries(totalDurPerUser)) {
          // Over 60h in a week is suspicious
          if (total > 60 * 3600) {
            flaggedUserIds.add(uid)
            alerts.push({
              type: 'excessive_playtime',
              severity: total > 100 * 3600 ? 'high' : 'medium',
              user_id: uid,
              username: null,
              detail: `${(total / 3600).toFixed(1)}h total in last 7 days (${sessionsPerUser[uid]} sessions)`,
              value: total,
              timestamp: null,
            })
          }
        }
      }

      // ── 4. Streak anomalies: unusually high streaks for account age ──
      const { data: streakUsers } = await supabase
        .from('profiles')
        .select('id, username, streak_count, created_at')
        .gt('streak_count', 0)
        .order('streak_count', { ascending: false })
        .limit(50)

      if (streakUsers?.length) {
        for (const u of streakUsers) {
          const accountAgeDays = (now - new Date(u.created_at)) / (24 * 60 * 60 * 1000)
          // Streak is more than account age (impossible without manipulation)
          if (u.streak_count > accountAgeDays + 1) {
            flaggedUserIds.add(u.id)
            alerts.push({
              type: 'streak_anomaly',
              severity: 'high',
              user_id: u.id,
              username: u.username,
              detail: `Streak ${u.streak_count}d but account is only ${Math.floor(accountAgeDays)}d old`,
              value: u.streak_count,
              timestamp: u.created_at,
            })
          }
        }
      }

      // ── 5. XP growth rate: check if any skill XP exceeds what's possible ──
      if (xpOutliers?.length) {
        // Get profile data for XP outliers
        const xpUserIds = [...new Set(xpOutliers.map(r => r.user_id))]
        const { data: xpProfiles } = await supabase
          .from('profiles')
          .select('id, username, created_at')
          .in('id', xpUserIds)

        const profileMap = {}
        for (const p of (xpProfiles || [])) profileMap[p.id] = p

        for (const row of xpOutliers) {
          const profile = profileMap[row.user_id]
          if (!profile) continue
          const accountAgeDays = Math.max(1, (now - new Date(profile.created_at)) / (24 * 60 * 60 * 1000))
          const xpPerDay = row.total_xp / accountAgeDays
          // Max reasonable XP per day: ~16h active at ~1 XP/sec = ~57600 XP/day per skill
          // Be generous: 100K/day is extremely suspicious
          if (xpPerDay > 100_000) {
            alerts.push({
              type: 'xp_rate_anomaly',
              severity: xpPerDay > 500_000 ? 'high' : 'medium',
              user_id: row.user_id,
              username: profile.username,
              detail: `${row.skill_id}: ${Math.round(xpPerDay).toLocaleString()} XP/day avg (${Number(row.total_xp).toLocaleString()} total, account ${Math.floor(accountAgeDays)}d old)`,
              value: xpPerDay,
              timestamp: row.updated_at,
            })
          }
        }
      }

      // ── 6. Marketplace suspicious activity ──
      const { data: trades } = await supabase
        .from('trade_history')
        .select('buyer_id, seller_id, item_id, unit_price, quantity, total_gold, traded_at')
        .gte('traded_at', weekAgo)
        .order('traded_at', { ascending: false })
        .limit(500)

      if (trades?.length) {
        // Self-trading detection (same buyer/seller via alt accounts)
        // Check for pairs that trade frequently with each other
        const pairTrades = {}
        for (const t of trades) {
          if (!t.buyer_id || !t.seller_id) continue
          const pair = [t.buyer_id, t.seller_id].sort().join('|')
          if (!pairTrades[pair]) pairTrades[pair] = { count: 0, totalGold: 0, buyer: t.buyer_id, seller: t.seller_id }
          pairTrades[pair].count++
          pairTrades[pair].totalGold += Number(t.total_gold) || 0
        }
        for (const [pair, info] of Object.entries(pairTrades)) {
          if (info.count >= 5) {
            flaggedUserIds.add(info.buyer)
            flaggedUserIds.add(info.seller)
            alerts.push({
              type: 'frequent_trading_pair',
              severity: info.count >= 10 ? 'high' : 'medium',
              user_id: info.buyer,
              username: null,
              detail: `${info.count} trades between 2 users totaling ${info.totalGold.toLocaleString()} gold in 7 days`,
              value: info.count,
              timestamp: null,
              extra: { pair: pair.split('|') },
            })
          }
        }

        // Suspiciously cheap or expensive trades (price manipulation)
        // Group by item to find avg price
        const itemPrices = {}
        for (const t of trades) {
          if (!itemPrices[t.item_id]) itemPrices[t.item_id] = []
          itemPrices[t.item_id].push(Number(t.unit_price) || 0)
        }
        for (const [itemId, prices] of Object.entries(itemPrices)) {
          if (prices.length < 3) continue
          const avg = prices.reduce((a, b) => a + b, 0) / prices.length
          for (const t of trades.filter(tr => tr.item_id === itemId)) {
            const price = Number(t.unit_price) || 0
            if (avg > 0 && (price < avg * 0.1 || price > avg * 10)) {
              flaggedUserIds.add(t.buyer_id)
              flaggedUserIds.add(t.seller_id)
              alerts.push({
                type: 'price_anomaly',
                severity: 'medium',
                user_id: t.seller_id,
                username: null,
                detail: `${itemId} traded at ${price} gold (avg: ${Math.round(avg)} gold) — ${price < avg ? 'suspiciously cheap' : 'suspiciously expensive'}`,
                value: price,
                timestamp: t.traded_at,
              })
            }
          }
        }
      }

      // ── 7. New accounts with high level (possible exploit) ──
      const { data: newHighLevel } = await supabase
        .from('profiles')
        .select('id, username, level, created_at, gold')
        .gte('created_at', weekAgo)
        .gt('level', 10)
        .order('level', { ascending: false })
        .limit(20)

      if (newHighLevel?.length) {
        for (const u of newHighLevel) {
          const ageDays = (now - new Date(u.created_at)) / (24 * 60 * 60 * 1000)
          flaggedUserIds.add(u.id)
          alerts.push({
            type: 'fast_progression',
            severity: u.level > 30 ? 'high' : 'medium',
            user_id: u.id,
            username: u.username,
            detail: `Level ${u.level} reached in ${ageDays.toFixed(1)} days, ${Number(u.gold).toLocaleString()} gold`,
            value: u.level,
            timestamp: u.created_at,
          })
        }
      }

      // ── Resolve missing usernames ──
      const needNames = alerts.filter(a => !a.username && a.user_id)
      if (needNames.length) {
        const ids = [...new Set(needNames.map(a => a.user_id))]
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username')
          .in('id', ids.slice(0, 50))
        if (profiles) {
          const nameMap = {}
          for (const p of profiles) nameMap[p.id] = p.username
          for (const a of alerts) {
            if (!a.username && nameMap[a.user_id]) a.username = nameMap[a.user_id]
          }
        }
      }

      // ── Sort by severity (high first), then deduplicate ──
      const severityOrder = { high: 0, medium: 1, low: 2 }
      alerts.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2))

      // Deduplicate: one alert per user+type
      const seen = new Set()
      const deduped = []
      for (const a of alerts) {
        const key = a.user_id + '|' + a.type
        if (seen.has(key)) continue
        seen.add(key)
        deduped.push(a)
      }

      // ── Build user detail summaries for flagged users ──
      const flaggedList = [...flaggedUserIds].slice(0, 50)
      let flaggedProfiles = []
      if (flaggedList.length) {
        const { data: fp } = await supabase
          .from('profiles')
          .select('id, username, level, gold, streak_count, created_at, updated_at, is_online')
          .in('id', flaggedList)
        flaggedProfiles = fp || []
      }

      return {
        alerts: deduped.slice(0, 100),
        totalAlerts: deduped.length,
        highCount: deduped.filter(a => a.severity === 'high').length,
        mediumCount: deduped.filter(a => a.severity === 'medium').length,
        flaggedUsers: flaggedProfiles,
        thresholds: {
          goldAvg: Math.round(avgGold),
          goldStdDev: Math.round(goldStdDev),
          goldThreshold: Math.round(goldThreshold),
        },
        generatedAt: new Date().toISOString(),
      }
    })
    res.json(data)
  } catch (err) {
    console.error('/api/abuse-detection', err)
    res.status(500).json({ error: String(err) })
  }
})

// ── Static ────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')))
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

app.listen(PORT, () => console.log(`[grindly-admin] running on port ${PORT}`))
