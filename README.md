# Trail Angels — Strava Summit Challenge Backend

Node.js + Express backend for the Trail Angels August Summit Challenge.
Handles Strava OAuth, segment effort tracking, club member filtering,
and leaderboard data for the WordPress frontend.

## What this does

- Lets Trail Angels members connect their Strava account in one click
- Checks they are a member of the Trail Angels Strava club
- Listens for new Strava activities via webhook
- Records every effort on the challenge climb segment
- Serves leaderboard data (fastest time + most efforts) to your WordPress page
- Calculates running donation total (R10 per effort)

## API Endpoints

| Method | Path                   | What it returns                            |
|--------|------------------------|--------------------------------------------|
| GET    | /auth/connect          | Redirects rider to Strava login            |
| GET    | /auth/callback         | Handles return from Strava after login     |
| GET    | /webhook               | Webhook verification (Strava requirement)  |
| POST   | /webhook               | Receives new activity notifications        |
| GET    | /leaderboard/fastest   | Best time per athlete this month           |
| GET    | /leaderboard/efforts   | Effort count per athlete + donation total  |
| GET    | /stats                 | Summary: total efforts + total raised      |

## Setup

1. Clone this repo
2. Copy .env.example to .env and fill in all values
3. npm install
4. npm start

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project from GitHub
3. Add all environment variables from .env.example in Railway > Variables
4. Railway auto-deploys on every push to main

## Register the Strava Webhook (once only)

After deploying, run this in your terminal:

```
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=YOUR_CLIENT_ID \
  -F client_secret=YOUR_CLIENT_SECRET \
  -F callback_url=https://YOUR_RAILWAY_URL.railway.app/webhook \
  -F verify_token=TRAIL_ANGELS_2026
```

## Monthly Reset

At the start of a new challenge month, update CHALLENGE_MONTH in Railway
from 2026-08 to the new month (e.g. 2026-09). Railway redeploys automatically.
Historical data stays in Supabase.

## Stack

- Runtime: Node.js 18+
- Framework: Express 4
- Database: Supabase (PostgreSQL)
- HTTP client: Axios
- Hosting: Railway
