# Vehicle Life Bot — Render + Supabase PostgreSQL + Vehicle Images

Vehicle Life turns Discord activity into a linear vehicle collection game. This version stores player progress in **Supabase PostgreSQL** and includes **34 bundled vehicle images**.

## Database: Supabase PostgreSQL

The MongoDB dependency has been completely removed.

The bot stores:

- Discord user ID
- Discord guild/server ID
- Message count
- VC time in seconds
- Vehicle index / collection progress
- Active VC join timestamp
- Last update timestamp

### Create the Supabase table

1. Create a Supabase project.
2. Open **SQL Editor**.
3. Paste and run [`supabase_schema.sql`](supabase_schema.sql).
4. In Supabase project settings, copy the project URL.
5. Create/copy the server-side **service role key**.

Keep the service-role key private. Put it only in Render Environment Variables.

## Render deployment

This package is configured as a **Web Service** so it can be deployed directly on Render. The bot starts a tiny HTTP health server on Render's `PORT` while maintaining its Discord Gateway connection.

Build command:

```text
npm install
```

Start command:

```text
npm start
```

Keep the repository **Root Directory blank** because `package.json` and `src/` are at the repository root.

Only run **one instance** of the bot. Multiple instances would duplicate Discord event processing and message/VC counting.

## Render environment variables

Set these variables in the Render service:

- `DISCORD_TOKEN` — your Discord bot token
- `CLIENT_ID` — your Discord Application ID
- `GUILD_ID` — your Discord server ID (recommended for fast guild slash-command registration)
- `TOP_GARAGES_CHANNEL_ID` — optional channel ID for Top Garages
- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — your Supabase server-side service-role key

There are **no MongoDB environment variables** in this version.

## Supabase security

Do not put `SUPABASE_SERVICE_ROLE_KEY` in frontend/client code or commit it to GitHub. It is a server secret. This Discord bot uses it from Render only.

## Vehicle images

All 34 vehicles have a bundled PNG image in `assets/vehicles/`. `/profile` shows the user's current vehicle image and `/garage` / `/viewgarage` show owned vehicle images with Previous / Next pagination.

## Commands

- `/profile` — current vehicle, image, stats and next unlock progress
- `/garage` — your complete vehicle collection with pagination
- `/viewgarage user:@Member` — view another member's complete collection
- `/topgarages` — leaderboard
- `/setup` — configure the current channel for leaderboard publishing

## Notes

The bot keeps an in-memory cache for fast Discord interactions and persists changes to Supabase using an ordered save queue. On startup it loads existing users from Supabase. On shutdown it also saves active VC time before closing.
