# Job Applier AI

> AI-powered automated job application agent — browse listings, auto-fill forms, and track applications using Claude + Playwright.

## What it does
- Scrapes job listings from configured portals
- Uses Claude AI to match your profile against job descriptions
- Auto-fills application forms via Playwright browser automation
- Tracks all applications in a JSON database with status updates
- Exposes a web dashboard to monitor applications

## Tech Stack
| Layer | Technology |
|---|---|
| Runtime | Node.js |
| AI | Claude (Anthropic) |
| Browser automation | Playwright |
| Backend | Express.js |
| Data | JSON flat-file DB |
| Deploy | Render (`render.yaml`) |

## Quick Start
```bash
cp .env.example .env
# Add your ANTHROPIC_API_KEY and other secrets to .env
npm install
node server.js
```
Open `http://localhost:3000`

## Project Structure
```
├── server.js          # Express server + API routes
├── scraper.js         # Playwright job-listing scraper
├── ai.js              # Claude integration (matching + form-fill)
├── db.js              # JSON database helpers
├── public/            # Frontend dashboard
├── data_profile.json  # Your resume/profile data
├── data_preferences.json  # Job search preferences
├── data_applications.json # Application history
└── render.yaml        # Render.com deployment config
```

## Environment Variables
```
ANTHROPIC_API_KEY=
# Add other keys as needed (see .env.example)
```

## Status
🚧 Active development
