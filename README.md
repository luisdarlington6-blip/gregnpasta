# gregnpasta

A two-image "branding recipe" tool: drop in a style reference image and a
subject image, and get back a recipe (palette, materials, accessories, and a
ready-to-use image-editing prompt) for applying traits from the reference
onto the subject — while keeping the subject's form, pose, and structure
locked exactly as-is.

## How it's structured

- `index.html` — the frontend (single static page, no build step)
- `api/recipe.js` — a serverless function that calls the Anthropic API
  (Claude Haiku 4.5) with your **server-side** API key, so the key is never
  exposed to visitors

## Deploying on Vercel (free)

1. **Get an Anthropic API key**
   - Go to https://console.anthropic.com
   - Sign up / log in, verify your phone number to claim your starter credit
   - Settings → API Keys → Create Key, copy it (starts with `sk-ant-...`)

2. **Push this folder to a GitHub repo**
   - Create a new repo, add these files (`index.html`, `api/recipe.js`,
     `package.json`), and push.

3. **Import the repo into Vercel**
   - Go to https://vercel.com → New Project → Import your repo
   - Framework preset: "Other" (it's just static + a serverless function,
     no build command needed)

4. **Add your API key as an environment variable**
   - In the Vercel project → Settings → Environment Variables
   - Add: `ANTHROPIC_API_KEY` = `sk-ant-...` (your key from step 1)
   - Make sure it's available to "Production" (and "Preview" if you want to
     test preview deployments too)

5. **Deploy**
   - Vercel will build automatically. Once done, you'll get a URL like
     `https://gregnpasta.vercel.app` — share that with anyone.

## Cost & rate limiting

- Uses `claude-haiku-4-5-20251001`, Anthropic's cheapest current model
  (~$1 input / $5 output per million tokens). Each "cook up a recipe" call
  costs roughly half a cent to a couple of cents depending on image size.
- `api/recipe.js` includes a basic per-IP daily limit (20 requests/day,
  configurable via the `DAILY_LIMIT` constant) to protect your budget. This
  limit is **in-memory per serverless instance**, so it's a soft limit —
  good enough for low/moderate traffic, but it can reset on cold starts or
  vary across instances under high traffic.
- For a stronger, shared rate limit across all instances, see the comment
  block at the bottom of `api/recipe.js` for how to wire up Upstash Redis
  (free tier) or Vercel KV — about 10 minutes of extra setup.

## Local testing

```bash
npm install -g vercel
vercel dev
```

This runs the frontend and the `/api/recipe` function locally. You'll need
a `.env` file with `ANTHROPIC_API_KEY=sk-ant-...` (Vercel CLI will prompt
you to link/create this, or create `.env.local` manually — do not commit it).
