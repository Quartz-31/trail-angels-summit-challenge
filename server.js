const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Debug: log what Railway is passing in
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET ✓' : 'MISSING ✗');
console.log('SUPABASE_KEY:', process.env.SUPABASE_KEY ? 'SET ✓' : 'MISSING ✗');
console.log('STRAVA_CLIENT_ID:', process.env.STRAVA_CLIENT_ID ? 'SET ✓' : 'MISSING ✗');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CORS: allow your WordPress site to call this backend ──────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Supabase client ───────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Strava config ─────────────────────────────────────────────────────────
const STRAVA = {
  clientId:     process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  clubId:       process.env.STRAVA_CLUB_ID,
  segmentId:    process.env.STRAVA_SEGMENT_ID,
  redirectUri:  process.env.REDIRECT_URI,
};

// ── Helper: format seconds as mm:ss ──────────────────────────────────────
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Helper: get current challenge month (YYYY-MM) ─────────────────────────
function challengeMonth() {
  return process.env.CHALLENGE_MONTH || new Date().toISOString().slice(0, 7);
}

// ── Helper: refresh a Strava token if expired ─────────────────────────────
async function refreshTokenIfNeeded(athlete) {
  const now = Math.floor(Date.now() / 1000);
  if (athlete.token_expires_at > now) return athlete.access_token;

  const { data } = await axios.post('https://www.strava.com/oauth/token', {
    client_id:     STRAVA.clientId,
    client_secret: STRAVA.clientSecret,
    grant_type:    'refresh_token',
    refresh_token: athlete.refresh_token,
  });

  await supabase.from('athletes').update({
    access_token:     data.access_token,
    refresh_token:    data.refresh_token,
    token_expires_at: data.expires_at,
  }).eq('strava_id', athlete.strava_id);

  return data.access_token;
}

// ── Helper: check if athlete is in the Trail Angels Strava club ───────────
async function isClubMember(accessToken, athleteStravaId) {
  try {
    let page = 1;
    while (true) {
      const { data: members } = await axios.get(
        `https://www.strava.com/api/v3/clubs/${STRAVA.clubId}/members`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { per_page: 200, page },
        }
      );
      if (members.length === 0) return false;
      if (members.some(m => m.id === athleteStravaId)) return true;
      page++;
    }
  } catch (err) {
    console.error('Club check failed:', err.message);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE 1 — /auth/connect
// Redirects the rider to Strava's OAuth login page
// ═════════════════════════════════════════════════════════════════════════════
app.get('/auth/connect', (req, res) => {
  const url = new URL('https://www.strava.com/oauth/authorize');
  url.searchParams.set('client_id',     STRAVA.clientId);
  url.searchParams.set('redirect_uri',  STRAVA.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('approval_prompt', 'auto');
  url.searchParams.set('scope',         'activity:read_all');
  res.redirect(url.toString());
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE 2 — /auth/callback
// Strava redirects here after the rider approves access
// Exchanges the code for tokens, checks club membership, saves athlete
// ═════════════════════════════════════════════════════════════════════════════
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received from Strava');

  try {
    // Exchange auth code for tokens
    const { data: tokenData } = await axios.post(
      'https://www.strava.com/oauth/token',
      {
        client_id:     STRAVA.clientId,
        client_secret: STRAVA.clientSecret,
        code,
        grant_type:    'authorization_code',
      }
    );

    const { athlete, access_token, refresh_token, expires_at } = tokenData;

    // Check Trail Angels club membership
    const memberStatus = await isClubMember(access_token, athlete.id);

    // Save or update athlete in database
    await supabase.from('athletes').upsert({
      strava_id:        athlete.id,
      first_name:       athlete.firstname,
      last_name:        athlete.lastname,
      access_token,
      refresh_token,
      token_expires_at: expires_at,
      is_club_member:   memberStatus,
    }, { onConflict: 'strava_id' });

    if (!memberStatus) {
      // Redirect to WordPress page with a "not a member" message
      return res.redirect(
        `${process.env.ALLOWED_ORIGIN}/summit-challenge?status=not_member`
      );
    }

    // Success — redirect back to the leaderboard page
    res.redirect(
      `${process.env.ALLOWED_ORIGIN}/summit-challenge?status=connected`
    );

  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.redirect(
      `${process.env.ALLOWED_ORIGIN}/summit-challenge?status=error`
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE 3 — /webhook (GET)
// Strava calls this once when you first register the webhook — do not remove
// ═════════════════════════════════════════════════════════════════════════════
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === 'TRAIL_ANGELS_2026') {
    return res.json({ 'hub.challenge': challenge });
  }
  res.sendStatus(403);
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE 4 — /webhook (POST)
// Strava posts here every time a connected athlete completes an activity
// ═════════════════════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  // Always acknowledge immediately — Strava expects a fast 200
  res.sendStatus(200);

  const { object_type, object_id, owner_id, aspect_type } = req.body;

  // Only care about new activities
  if (object_type !== 'activity' || aspect_type !== 'create') return;

  try {
    // Look up the athlete
    const { data: athlete } = await supabase
      .from('athletes')
      .select('*')
      .eq('strava_id', owner_id)
      .single();

    if (!athlete || !athlete.is_club_member) return;

    const token = await refreshTokenIfNeeded(athlete);

    // Fetch the full activity from Strava
    const { data: activity } = await axios.get(
      `https://www.strava.com/api/v3/activities/${object_id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Check if the activity contains our segment
    const segmentEfforts = activity.segment_efforts || [];
    const ourSegment = segmentEfforts.find(
      e => String(e.segment.id) === String(STRAVA.segmentId)
    );

    if (!ourSegment) return; // Activity doesn't include our climb

    // Check the effort falls in the challenge month
    const effortDate = ourSegment.start_date_local.slice(0, 10); // YYYY-MM-DD
    if (!effortDate.startsWith(challengeMonth())) return;

    // Save the effort
    await supabase.from('efforts').insert({
      athlete_id:          owner_id,
      strava_activity_id:  object_id,
      elapsed_seconds:     ourSegment.elapsed_time,
      effort_date:         effortDate,
    });

    console.log(`Recorded: ${athlete.first_name} ${athlete.last_name} — ${formatTime(ourSegment.elapsed_time)}`);

  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE 5 — /leaderboard/fastest
// Returns each club member's best (lowest) effort time for the current month
// ═════════════════════════════════════════════════════════════════════════════
app.get('/leaderboard/fastest', async (req, res) => {
  const month = challengeMonth();

  // Get all efforts for this month from club members only
  const { data: efforts, error } = await supabase
    .from('efforts')
    .select(`
      elapsed_seconds,
      effort_date,
      athletes (
        strava_id,
        first_name,
        last_name,
        is_club_member
      )
    `)
    .gte('effort_date', `${month}-01`)
    .lte('effort_date', `${month}-31`);

  if (error) return res.status(500).json({ error: error.message });

  // Filter to club members only, then find each athlete's best time
  const bestByAthlete = {};
  for (const effort of efforts) {
    const a = effort.athletes;
    if (!a || !a.is_club_member) continue;
    const key = a.strava_id;
    if (!bestByAthlete[key] || effort.elapsed_seconds < bestByAthlete[key].elapsed_seconds) {
      bestByAthlete[key] = {
        strava_id:       a.strava_id,
        name:            `${a.first_name} ${a.last_name}`,
        elapsed_seconds: effort.elapsed_seconds,
        time_formatted:  formatTime(effort.elapsed_seconds),
        effort_date:     effort.effort_date,
      };
    }
  }

  // Sort fastest first
  const ranked = Object.values(bestByAthlete)
    .sort((a, b) => a.elapsed_seconds - b.elapsed_seconds);

  res.json({ month, leaderboard: ranked });
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE 6 — /leaderboard/efforts
// Returns total effort count per club member for the current month
// ═════════════════════════════════════════════════════════════════════════════
app.get('/leaderboard/efforts', async (req, res) => {
  const month = challengeMonth();
  const donationPerEffort = parseInt(process.env.DONATION_PER_EFFORT || '10', 10);

  const { data: efforts, error } = await supabase
    .from('efforts')
    .select(`
      athlete_id,
      effort_date,
      athletes (
        strava_id,
        first_name,
        last_name,
        is_club_member
      )
    `)
    .gte('effort_date', `${month}-01`)
    .lte('effort_date', `${month}-31`);

  if (error) return res.status(500).json({ error: error.message });

  const countByAthlete = {};
  for (const effort of efforts) {
    const a = effort.athletes;
    if (!a || !a.is_club_member) continue;
    const key = a.strava_id;
    if (!countByAthlete[key]) {
      countByAthlete[key] = {
        strava_id:  a.strava_id,
        name:       `${a.first_name} ${a.last_name}`,
        efforts:    0,
        last_date:  effort.effort_date,
      };
    }
    countByAthlete[key].efforts++;
    if (effort.effort_date > countByAthlete[key].last_date) {
      countByAthlete[key].last_date = effort.effort_date;
    }
  }

  // Sort most efforts first
  const ranked = Object.values(countByAthlete)
    .sort((a, b) => b.efforts - a.efforts);

  // Total efforts for donation counter
  const totalEfforts = ranked.reduce((sum, a) => sum + a.efforts, 0);
  const totalDonation = totalEfforts * donationPerEffort;

  res.json({
    month,
    donation_per_effort: donationPerEffort,
    total_efforts:       totalEfforts,
    total_donated:       totalDonation,
    leaderboard:         ranked,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE 7 — /stats
// Summary numbers for the donation banner at the top of the page
// ═════════════════════════════════════════════════════════════════════════════
app.get('/stats', async (req, res) => {
  const month = challengeMonth();
  const donationPerEffort = parseInt(process.env.DONATION_PER_EFFORT || '10', 10);

  const { count } = await supabase
    .from('efforts')
    .select('*', { count: 'exact', head: true })
    .gte('effort_date', `${month}-01`)
    .lte('effort_date', `${month}-31`);

  res.json({
    month,
    total_efforts:   count || 0,
    total_donated:   (count || 0) * donationPerEffort,
    donation_rate:   donationPerEffort,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Start server
// ═════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Trail Angels backend running on port ${PORT}`);
  console.log(`Challenge month: ${challengeMonth()}`);
  console.log(`Segment ID: ${STRAVA.segmentId || 'NOT SET YET'}`);
});
