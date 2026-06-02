# Influence Map Builder

Discover who dominates the spoken media conversation for any brand or keyword — powered by [All Ears](https://allears.ai) and Claude.

## Deploy on Railway (recommended)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select this repo
4. Add environment variable: `ANTHROPIC_API_KEY=your_key_here`
5. Done — Railway builds and deploys automatically

## Local development

```bash
npm install
echo "ANTHROPIC_API_KEY=your_key" > .env
npm run dev
```

Open http://localhost:5173

## How it works

1. **Disambiguate** — samples raw snippets and detects keyword noise
2. **Refine** — if noisy, Claude generates near/not-near filters automatically  
3. **Fetch** — pulls top creators, channels, and co-occurring terms from All Ears
4. **Analyze** — Claude generates 3 strategic insights from the data
5. **Display** — tiered influence map across Creators, Channels, and Themes tabs
