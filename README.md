# Brewery Sensory App

## What's in this folder

- `src/App.jsx` — the whole app
- `src/supabaseClient.js` — connects to your Supabase project (reads from environment variables, set in Vercel later)
- `supabase-schema-part2.sql` — one more table to add (run in Supabase's SQL Editor, after the first schema file you already ran)
- Everything else is standard project setup (Vite, package.json, etc.) — no need to touch it

## Next steps

1. Run `supabase-schema-part2.sql` in Supabase's SQL Editor (same place you ran the first one).
2. Upload this whole folder to a new GitHub repository.
3. In Vercel, import that repository. When it asks for environment variables, add:
   - `VITE_SUPABASE_URL` — from Supabase: Project Settings → API → Project URL
   - `VITE_SUPABASE_ANON_KEY` — from Supabase: Project Settings → API → anon public key
4. Deploy. Vercel gives you a URL — that's your live app.
5. Sign in with the account you already created in Supabase, or sign up fresh from the app itself.
