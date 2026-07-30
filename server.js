const express = require('express');
const axios   = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Lazy Supabase client ──────────────────────────────────────────────────────
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
  redirectUri:  process.env.REDIRECT_URI,
};

// ── Segment IDs ───────────────────────────────────────────────────────────────
const SEGMENT_ID_ANALOG = parseInt(process.env.SEGMENT_ID_ANALOG || '41844407', 10);
const SEGMENT_ID_EBIKE  = parseInt(process.env.SEGMENT_ID_EBIKE  || '41893406', 10);

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

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:         'ok',
    month:          challengeMonth(),
    segment_analog: SEGMENT_ID_ANALOG,
    segment_ebike:  SEGMENT_ID_EBIKE,
  });
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

    await getSupabase().from('athletes').upsert({
      strava_id:        athlete.id,
      first_name:       athlete.firstname,
      last_name:        athlete.lastname,
      profile_url:      athlete.profile || '',
      access_token,
      refresh_token,
      token_expires_at: expires_at,
      sex:              athlete.sex,
    }, { onConflict: 'strava_id' });

    return res.redirect(
      `${process.env.ALLOWED_ORIGIN}/summit-for-dignity-challenge` +
      `?connected=true` +
      `&firstname=${encodeURIComponent(athlete.firstname)}` +
      `&lastname=${encodeURIComponent(athlete.lastname)}` +
      `&profile=${encodeURIComponent(athlete.profile || '')}`
    );

  } catch (err) {
    console.error('Auth callback error:', err.message);
    return res.redirect(`${process.env.ALLOWED_ORIGIN}/summit-for-dignity-challenge?status=error`);
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
// Checks the incoming activity for efforts on EITHER the analog or e-bike segment.
// Records each matching effort with its segment_type ('analog' or 'ebike').
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const { object_type, object_id, owner_id, aspect_type } = req.body;
  if (object_type !== 'activity' || aspect_type !== 'create') return;

  try {
    const { data: athlete } = await getSupabase()
      .from('athletes')
      .select('*')
      .eq('strava_id', owner_id)
      .single();

    if (!athlete) return; // athlete hasn't connected via our app

    const token = await refreshTokenIfNeeded(athlete);

    const { data: activity } = await axios.get(
      `https://www.strava.com/api/v3/activities/${object_id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const segmentEfforts = activity.segment_efforts || [];

    // Check for analog segment effort
    const analogEffort = segmentEfforts.find(
      e => Number(e.segment.id) === SEGMENT_ID_ANALOG
    );

    // Check for e-bike segment effort
    const ebikeEffort = segmentEfforts.find(
      e => Number(e.segment.id) === SEGMENT_ID_EBIKE
    );

    const month = challengeMonth();

    // Record analog effort if found and within challenge month
    if (analogEffort) {
      const effortDate = analogEffort.start_date_local.slice(0, 10);
      if (effortDate.startsWith(month)) {
        await getSupabase().from('efforts').upsert({
          strava_activity_id: object_id,
          athlete_id:         owner_id,
          elapsed_seconds:    analogEffort.elapsed_time,
          effort_date:        effortDate,
          segment_id:         SEGMENT_ID_ANALOG,
          segment_type:       'analog',
        }, { onConflict: 'strava_activity_id' });
        console.log(`Recorded analog: ${athlete.first_name} ${athlete.last_name} — ${formatTime(analogEffort.elapsed_time)}`);
      }
    }

    // Record e-bike effort if found and within challenge month
    if (ebikeEffort) {
      const effortDate = ebikeEffort.start_date_local.slice(0, 10);
      if (effortDate.startsWith(month)) {
        await getSupabase().from('efforts').upsert({
          strava_activity_id: `${object_id}_ebike`, // unique key for e-bike effort
          athlete_id:         owner_id,
          elapsed_seconds:    ebikeEffort.elapsed_time,
          effort_date:        effortDate,
          segment_id:         SEGMENT_ID_EBIKE,
          segment_type:       'ebike',
        }, { onConflict: 'strava_activity_id' });
        console.log(`Recorded ebike: ${athlete.first_name} ${athlete.last_name} — ${formatTime(ebikeEffort.elapsed_time)}`);
      }
    }

  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// ── Leaderboard: fastest time ─────────────────────────────────────────────────
// Women only. Toggle between analog and e-bike with ?type=analog or ?type=ebike
// Defaults to analog if no type specified.
app.get('/leaderboard/fastest', async (req, res) => {
  const month      = challengeMonth();
  const monthStart = `${month}-01`;
  const monthEnd   = `${month}-31`;
  const bikeType   = req.query.type === 'ebike' ? 'ebike' : 'analog';

  try {
    const { data: efforts, error } = await getSupabase()
      .from('efforts')
      .select('elapsed_seconds, effort_date, segment_type, athletes(strava_id, first_name, last_name, profile_url, sex)')
      .eq('segment_type', bikeType)
      .gte('effort_date', monthStart)
      .lte('effort_date', monthEnd);

    if (error) return res.status(500).json({ error: error.message });

    const best = {};
    for (const e of efforts) {
      const a = e.athletes;
      if (!a || a.sex !== 'F') continue; // women only

      if (!best[a.strava_id] || e.elapsed_seconds < best[a.strava_id].elapsed_seconds) {
        best[a.strava_id] = {
          firstname:       a.first_name,
          lastname:        a.last_name,
          profile:         a.profile_url,
          elapsed_seconds: e.elapsed_seconds,
          best_time:       formatTime(e.elapsed_seconds),
        };
      }
    }

    const leaderboard = Object.values(best)
      .sort((a, b) => a.elapsed_seconds - b.elapsed_seconds)
      .slice(0, 10)
      .map((a, i) => ({ rank: i + 1, ...a }));

    res.json({ month, type: bikeType, leaderboard });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Leaderboard: most efforts ─────────────────────────────────────────────────
// Women only. Combined across analog and e-bike segments.
app.get('/leaderboard/efforts', async (req, res) => {
  const month             = challengeMonth();
  const monthStart        = `${month}-01`;
  const monthEnd          = `${month}-31`;
  const donationPerEffort = parseInt(process.env.DONATION_PER_EFFORT || '10', 10);

  try {
    const { data: efforts, error } = await getSupabase()
      .from('efforts')
      .select('athlete_id, effort_date, athletes(strava_id, first_name, last_name, profile_url, sex)')
      .gte('effort_date', monthStart)
      .lte('effort_date', monthEnd);

    if (error) return res.status(500).json({ error: error.message });

    const counts = {};
    for (const e of efforts) {
      const a = e.athletes;
      if (!a || a.sex !== 'F') continue; // women only

      if (!counts[a.strava_id]) {
        counts[a.strava_id] = {
          firstname:    a.first_name,
          lastname:     a.last_name,
          profile:      a.profile_url,
          effort_count: 0,
        };
      }
      counts[a.strava_id].effort_count++;
    }

    const leaderboard = Object.values(counts)
      .sort((a, b) => b.effort_count - a.effort_count)
      .map((a, i) => ({ rank: i + 1, ...a }));

    res.json({ month, donation_per_effort: donationPerEffort, leaderboard });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Leaderboard: first timers ─────────────────────────────────────────────────
// Women only. Combined across both bike types.
// Athletes who have efforts this month but have never done either segment before.
app.get('/leaderboard/first-timers', async (req, res) => {
  const month      = challengeMonth();
  const monthStart = `${month}-01`;
  const monthEnd   = `${month}-31`;

  try {
    const { data: allEfforts, error } = await getSupabase()
      .from('efforts')
      .select('athlete_id, effort_date, athletes(strava_id, first_name, last_name, profile_url, sex)')
      .order('effort_date', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const byAthlete = {};
    for (const e of allEfforts) {
      const a = e.athletes;
      if (!a || a.sex !== 'F') continue; // women only

      if (!byAthlete[a.strava_id]) {
        byAthlete[a.strava_id] = {
          first_name:        a.first_name,
          last_name:         a.last_name,
          profile:           a.profile_url,
          hasPreMonthEffort: false,
          thisMonthCount:    0,
        };
      }

      if (e.effort_date < monthStart) {
        byAthlete[a.strava_id].hasPreMonthEffort = true;
      }
      if (e.effort_date >= monthStart && e.effort_date <= monthEnd) {
        byAthlete[a.strava_id].thisMonthCount++;
      }
    }

    const firstTimers = Object.values(byAthlete)
      .filter(a => a.thisMonthCount > 0 && !a.hasPreMonthEffort)
      .sort((a, b) => a.first_name.localeCompare(b.first_name))
      .map(a => ({
        firstname:    a.first_name,
        lastname:     a.last_name,
        profile:      a.profile,
        effort_count: a.thisMonthCount,
      }));

    res.json(firstTimers);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
// All genders, both bike types.
// Donation = (total efforts × R10) + (unique participants × R120 entry fee)
app.get('/stats', async (req, res) => {
  const month      = challengeMonth();
  const monthStart = `${month}-01`;
  const monthEnd   = `${month}-31`;
  const entryFee   = parseInt(process.env.ENTRY_FEE           || '120', 10);
  const perEffort  = parseInt(process.env.DONATION_PER_EFFORT || '10',  10);

  try {
    const { data: efforts, error } = await getSupabase()
      .from('efforts')
      .select('athlete_id')
      .gte('effort_date', monthStart)
      .lte('effort_date', monthEnd);

    if (error) return res.status(500).json({ error: error.message });

    const totalEfforts       = efforts.length;
    const uniqueParticipants = new Set(efforts.map(e => e.athlete_id)).size;
    const totalRaised        = (totalEfforts * perEffort) + (uniqueParticipants * entryFee);

    res.json({ month, totalEfforts, uniqueParticipants, totalRaised });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Trail Angels backend running on port ${PORT}`);
  console.log(`Challenge month: ${challengeMonth()}`);
  console.log(`Analog segment: ${SEGMENT_ID_ANALOG}`);
  console.log(`E-bike segment: ${SEGMENT_ID_EBIKE}`);
});
