const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Lazy Supabase client (created on first use, not at startup) ───────────────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );
  }
  return _supabase;
}

// ── Strava config ─────────────────────────────────────────────────────────────
const STRAVA = {
  clientId:     process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  clubId:       process.env.STRAVA_CLUB_ID,
  segmentId:    process.env.STRAVA_SEGMENT_ID,
  redirectUri:  process.env.REDIRECT_URI,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function challengeMonth() {
  return process.env.CHALLENGE_MONTH || new Date().toISOString().slice(0, 7);
}

async function refreshTokenIfNeeded(athlete) {
  const now = Math.floor(Date.now() / 1000);
  if (athlete.token_expires_at > now) return athlete.access_token;
  const { data } = await axios.post('https://www.strava.com/oauth/token', {
    client_id:     STRAVA.clientId,
    client_secret: STRAVA.clientSecret,
    grant_type:    'refresh_token',
    refresh_token: athlete.refresh_token,
  });
  await getSupabase().from('athletes').update({
    access_token:     data.access_token,
    refresh_token:    data.refresh_token,
    token_expires_at: data.expires_at,
  }).eq('strava_id', athlete.strava_id);
  return data.access_token;
}

async function isClubMember(accessToken, athleteStravaId) {
  try {
    let page = 1;
    while (true) {
      const { data: members } = await axios.get(
         `https://www.strava.com/api/v3/clubs/${STRAVA.clubId}/members`,
        { headers: { Authorization: `Bearer ${accessToken}` }, params: { per_page: 200, page } }
      );
      console.log(`Club check page ${page}: found ${members.length} members, looking for athlete ${athleteStravaId}`);
      if (members.length === 0) return false;
      if (members.some(m => m.id == athleteStravaId)) return true;
      page++;
    }
  } catch (err) {
    console.error('Club check failed:', err.message);
    return false;
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', month: challengeMonth(), segment: STRAVA.segmentId });
});

// ── Auth: redirect to Strava ──────────────────────────────────────────────────
app.get('/auth/connect', (req, res) => {
  const url = new URL('https://www.strava.com/oauth/authorize');
  url.searchParams.set('client_id',       STRAVA.clientId);
  url.searchParams.set('redirect_uri',    STRAVA.redirectUri);
  url.searchParams.set('response_type',   'code');
  url.searchParams.set('approval_prompt', 'auto');
  url.searchParams.set('scope',           'activity:read_all');
  res.redirect(url.toString());
});

// ── Auth: callback from Strava ────────────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received from Strava');
  try {
    const { data: tokenData } = await axios.post('https://www.strava.com/oauth/token', {
      client_id:     STRAVA.clientId,
      client_secret: STRAVA.clientSecret,
      code,
      grant_type:    'authorization_code',
    });
    const { athlete, access_token, refresh_token, expires_at } = tokenData;
    const memberStatus = await isClubMember(access_token, athlete.id);
    await getSupabase().from('athletes').upsert({
      strava_id:        athlete.id,
      first_name:       athlete.firstname,
      last_name:        athlete.lastname,
      access_token,
      refresh_token,
      token_expires_at: expires_at,
      is_club_member:   memberStatus,
    }, { onConflict: 'strava_id' });
    if (!memberStatus) {
      return res.redirect(`${process.env.ALLOWED_ORIGIN}/summit-for-dignity-challenge?status=not_member`);
    }
    res.redirect(`${process.env.ALLOWED_ORIGIN}/summit-for-dignity-challenge?connected=true&firstname=${encodeURIComponent(athlete.firstname)}&lastname=${encodeURIComponent(athlete.lastname)}&profile=${encodeURIComponent(athlete.profile || '')}`);
    // not a member
return res.redirect(`${process.env.ALLOWED_ORIGIN}/summit-for-dignity-challenge?status=not_member`);

// error
res.redirect(`${process.env.ALLOWED_ORIGIN}/summit-for-dignity-challenge?status=error`);
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.redirect(`${process.env.ALLOWED_ORIGIN}/summit-for-dignity-challenge?status=error`);
  }
});

// ── Webhook: verification (GET) ───────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log('Webhook verification attempt:', { mode, token, challenge });
  if (mode === 'subscribe' && token === 'TRAIL_ANGELS_2026') {
    console.log('Webhook verified successfully');
    return res.status(200).json({ 'hub.challenge': challenge });
  }
  console.log('Webhook verification failed');
  res.sendStatus(403);
});

// ── Webhook: receive activity (POST) ──────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const { object_type, object_id, owner_id, aspect_type } = req.body;
  if (object_type !== 'activity' || aspect_type !== 'create') return;
  try {
    const { data: athlete } = await getSupabase()
      .from('athletes').select('*').eq('strava_id', owner_id).single();
    if (!athlete || !athlete.is_club_member) return;
    const token = await refreshTokenIfNeeded(athlete);
    const { data: activity } = await axios.get(
      `https://www.strava.com/api/v3/activities/${object_id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const ourSegment = (activity.segment_efforts || []).find(
      e => String(e.segment.id) === String(STRAVA.segmentId)
    );
    if (!ourSegment) return;
    const effortDate = ourSegment.start_date_local.slice(0, 10);
    if (!effortDate.startsWith(challengeMonth())) return;
    await getSupabase().from('efforts').insert({
      athlete_id:         owner_id,
      strava_activity_id: object_id,
      elapsed_seconds:    ourSegment.elapsed_time,
      effort_date:        effortDate,
    });
    console.log(`Recorded: ${athlete.first_name} ${athlete.last_name} — ${formatTime(ourSegment.elapsed_time)}`);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// ── Leaderboard: fastest time ─────────────────────────────────────────────────
app.get('/leaderboard/fastest', async (req, res) => {
  const month = challengeMonth();
  try {
    const { data: efforts, error } = await getSupabase()
      .from('efforts')
      .select('elapsed_seconds, effort_date, athletes(strava_id, first_name, last_name, is_club_member)')
      .gte('effort_date', `${month}-01`)
      .lte('effort_date', `${month}-31`);
    if (error) return res.status(500).json({ error: error.message });
    const best = {};
    for (const e of efforts) {
      const a = e.athletes;
      if (!a || !a.is_club_member) continue;
      if (!best[a.strava_id] || e.elapsed_seconds < best[a.strava_id].elapsed_seconds) {
        best[a.strava_id] = {
          name:            `${a.first_name} ${a.last_name}`,
          elapsed_seconds: e.elapsed_seconds,
          time_formatted:  formatTime(e.elapsed_seconds),
          effort_date:     e.effort_date,
        };
      }
    }
    const ranked = Object.values(best).sort((a, b) => a.elapsed_seconds - b.elapsed_seconds);
    res.json({ month, leaderboard: ranked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Leaderboard: most efforts ─────────────────────────────────────────────────
app.get('/leaderboard/efforts', async (req, res) => {
  const month = challengeMonth();
  const donationPerEffort = parseInt(process.env.DONATION_PER_EFFORT || '10', 10);
  try {
    const { data: efforts, error } = await getSupabase()
      .from('efforts')
      .select('athlete_id, effort_date, athletes(strava_id, first_name, last_name, is_club_member)')
      .gte('effort_date', `${month}-01`)
      .lte('effort_date', `${month}-31`);
    if (error) return res.status(500).json({ error: error.message });
    const counts = {};
    for (const e of efforts) {
      const a = e.athletes;
      if (!a || !a.is_club_member) continue;
      if (!counts[a.strava_id]) {
        counts[a.strava_id] = { name: `${a.first_name} ${a.last_name}`, efforts: 0, last_date: e.effort_date };
      }
      counts[a.strava_id].efforts++;
      if (e.effort_date > counts[a.strava_id].last_date) counts[a.strava_id].last_date = e.effort_date;
    }
    const ranked = Object.values(counts).sort((a, b) => b.efforts - a.efforts);
    const totalEfforts = ranked.reduce((s, a) => s + a.efforts, 0);
    res.json({ month, donation_per_effort: donationPerEffort, total_efforts: totalEfforts, total_donated: totalEfforts * donationPerEffort, leaderboard: ranked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
  const month = challengeMonth();
  const donationPerEffort = parseInt(process.env.DONATION_PER_EFFORT || '10', 10);
  try {
    const { count } = await getSupabase()
      .from('efforts')
      .select('*', { count: 'exact', head: true })
      .gte('effort_date', `${month}-01`)
      .lte('effort_date', `${month}-31`);
    res.json({ month, total_efforts: count || 0, total_donated: (count || 0) * donationPerEffort, donation_rate: donationPerEffort });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Trail Angels backend running on port ${PORT}`);
  console.log(`Challenge month: ${challengeMonth()}`);
  console.log(`Segment ID: ${STRAVA.segmentId || 'NOT SET YET'}`);
});
