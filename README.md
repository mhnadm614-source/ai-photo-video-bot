# ai-photo-video-bot — Cloudflare starter

This starter runs a Telegram bot using a Cloudflare Worker and D1.

## Included now
- Telegram webhook endpoint with secret-header validation
- `/start`, `/help`, `/balance`, `/daily`, `/invite`
- 5-point referral reward, once per newly registered Telegram user
- Daily reward of 2 points (once per UTC day)
- Receives and records Telegram photo, video, and document file IDs in D1

## Not included yet
Image editing and image-to-video generation are not implemented in this starter.
They require a compatible AI provider/model and its API credentials. The bot currently
acknowledges media and stores Telegram file IDs; it does not claim to transform them.

## Cloudflare setup
1. Create/apply the D1 schema using `schema.sql`.
2. In Worker settings, keep the D1 binding named `DB` and connect it to `ai-photo-video-db`.
3. Add these Worker secrets:
   - `BOT_TOKEN`: token from BotFather
   - `WEBHOOK_SECRET`: random secret string (use letters/numbers/underscore/hyphen)
   - `SETUP_SECRET`: a separate long random secret used only for the setup URL
4. Deploy the Worker.
5. Send a POST request to `https://YOUR-WORKER.workers.dev/setup?key=YOUR_SETUP_SECRET`.
   This calls Telegram `setWebhook` and points it to `/telegram`.
6. Send `/start` to your Telegram bot.

Do not put bot tokens or setup secrets in GitHub files or public code.

## Important
The current referral reward is issued only when a genuinely new user starts with
`/start ref_TELEGRAM_ID`. The referred user is counted once because
`referrals.referred_user_id` is UNIQUE. A user who already exists cannot generate
another referral reward by restarting.
