// api/recipe.js
// Vercel serverless function that proxies requests to the Anthropic API
// using a server-side API key (never exposed to the browser), with a
// simple per-IP daily rate limit to protect your usage budget.

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 2000;

// Simple in-memory daily rate limit.
// NOTE: this resets whenever the serverless function "cold starts" and is
// per-instance, so it's a soft limit, not a hard guarantee. For a stronger
// limit across all instances, swap this for Upstash Redis (free tier) or
// Vercel KV — see comment at the bottom of this file.
const DAILY_LIMIT = 20; // max requests per IP per day
const usage = new Map(); // ip -> { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = usage.get(ip);

  if (!entry || now > entry.resetAt) {
    usage.set(ip, { count: 1, resetAt: now + 24 * 60 * 60 * 1000 });
    return true;
  }

  if (entry.count >= DAILY_LIMIT) {
    return false;
  }

  entry.count += 1;
  return true;
}

const SYSTEM_PROMPT = `You are a senior brand and visual-design consultant. You will be shown two images.
Image 1 is the STYLE REFERENCE — only used as a donor of specific surface traits: color palette, accessories/props, materials, textures, and other unique distinguishing details.
Image 2 is the SUBJECT — this is the locked anchor. Its form, shape, proportions, pose, structure, framing, and identity must be preserved EXACTLY and are NOT to be changed.

The goal is NOT a generic "style transfer" or blend. The goal is: take the SUBJECT exactly as it is (same form, same structure, same pose/layout, same identity) and selectively apply ONLY specific borrowed traits from the STYLE REFERENCE — for example its color palette, materials/textures, accessories, patterns, or other standout unique features you identify in image 1. Everything about the SUBJECT's underlying form, shape, and structure stays untouched.

First, identify 2-5 concrete, transferable traits from the STYLE REFERENCE (e.g. "burnt-orange and cream color scheme", "gold chain accessory", "woven straw texture", "geometric line pattern") — pick things that can be applied onto the subject WITHOUT altering its form.
Then write a precise, practical "recipe" for applying exactly those traits onto the SUBJECT while keeping its form 100% intact, suitable for handing to a designer or pasting into an AI image editing tool (e.g. an image-to-image / inpainting tool that takes the subject image as the base).

Respond with ONLY valid JSON, no markdown fences, no commentary, matching exactly this shape:
{
  "title": "short punchy name for this recipe, max 6 words",
  "locked_form": "1-2 sentences describing exactly what about the SUBJECT (image 2) must stay unchanged: its shape, pose, structure, proportions, framing, identity",
  "borrowed_traits": [ "trait 1 from the style reference to apply, stated concretely", "trait 2", ... 2 to 5 entries ],
  "palette": [ { "name": "color name", "hex": "#RRGGBB" }, ... 3 to 6 entries, ONLY the colors being borrowed from the style reference and applied to the subject ],
  "typography_materials": "1-3 sentences describing which materials, textures, accessories, or finishes from the style reference are being applied onto the subject, and where on the subject they go",
  "composition": [ "step 1: ...", "step 2: ...", "3-6 short concrete steps for applying the borrowed traits onto the subject while preserving its form" ],
  "mood": "1-2 sentences on the resulting feel once the subject (unchanged in form) carries these borrowed traits",
  "full_prompt": "a single dense, detailed paragraph (100-180 words) written as an image-EDITING instruction. It must explicitly state that the base image's form, shape, structure, pose, and proportions must remain exactly as-is/unchanged, and then describe precisely which colors, materials, accessories, patterns or details to add or recolor onto it, drawn from the style reference. Do not mention 'image 1' or 'image 2' by number — refer to 'the base image' (the subject) and describe the traits to apply onto it directly."
}`;

export default async function handler(req, res) {
  // CORS (adjust origin if you want to lock this down to your domain only)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: "Daily limit reached for your IP. Please try again tomorrow."
    });
  }

  const { style, subject } = req.body || {};

  if (!style?.base64 || !style?.mediaType || !subject?.base64 || !subject?.mediaType) {
    return res.status(400).json({ error: "Missing style or subject image data." });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Image 1 (style reference):" },
              {
                type: "image",
                source: { type: "base64", media_type: style.mediaType, data: style.base64 }
              },
              { type: "text", text: "Image 2 (subject to rebrand):" },
              {
                type: "image",
                source: { type: "base64", media_type: subject.mediaType, data: subject.base64 }
              },
              { type: "text", text: "Produce the JSON recipe now." }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      return res.status(502).json({ error: "Upstream API error", status: response.status });
    }

    const data = await response.json();
    const textBlock = data.content?.find((c) => c.type === "text");

    if (!textBlock) {
      return res.status(502).json({ error: "No text content in response" });
    }

    let clean = textBlock.text
      .trim()
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();

    const firstBrace = clean.indexOf("{");
    const lastBrace = clean.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      clean = clean.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      if (data.stop_reason === "max_tokens") {
        return res.status(502).json({
          error: "Response was cut off before completing. Please try again."
        });
      }
      console.error("JSON parse error:", parseErr, clean);
      return res.status(502).json({ error: "Could not parse model response." });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ---------------------------------------------------------------------
// Upgrading the rate limit to a persistent store (recommended once you
// have real traffic):
//
// 1. Create a free Upstash Redis database (upstash.com), or enable
//    Vercel KV from your project's Storage tab.
// 2. npm install @upstash/redis
// 3. Replace the `usage` Map + checkRateLimit() with calls like:
//
//    import { Redis } from "@upstash/redis";
//    const redis = Redis.fromEnv();
//    const key = `usage:${ip}:${new Date().toISOString().slice(0,10)}`;
//    const count = await redis.incr(key);
//    if (count === 1) await redis.expire(key, 60 * 60 * 24);
//    if (count > DAILY_LIMIT) { /* return 429 */ }
// ---------------------------------------------------------------------
