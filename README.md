# HR Hub: Talent Copilot

A centered chat copilot for HR. It sends questions to the **Talent Copilot** agent in Automation Anywhere EKB (project **CATS**), which searches candidates and resumes in **CATS**, and shows the results as candidate cards with a **View resume** button.

```
Browser (public/index.html)
   │  POST /api/chat (streamed)          GET /api/resume/:candidateId
   ▼                                      ▼
server.js ──► EKB API (api.getodin.ai) ──► Talent Copilot agent ──► CATS search tool
         └──► CATS API (latest resume file for a candidate)
```

All keys stay on the server. The browser never sees the EKB or CATS keys.

## 1. One-time setup in EKB

1. Open the **CATS** project > **Agents** > **Talent Copilot** and click **Promote to Live**.
2. Project **Settings > API Keys**: create an API key. Copy the **key** and **secret** into `.env` (next step).
3. Make sure the vault secret `cats_api_key` holds your **new** CATS key (the old one was exposed in a screenshot).

## 2. Run it

Needs Node 18 or newer. No `npm install` needed (zero dependencies).

```bash
cp .env.example .env     # then fill in the values
npm start                # http://localhost:3000
```

| Variable | What it is |
|---|---|
| `EKB_API_KEY`, `EKB_API_SECRET` | From EKB project Settings > API Keys |
| `EKB_PROJECT_ID` | `b5d379edc0134be588136d` (the CATS project) |
| `EKB_AGENT_ID` | `66244` (Talent Copilot) |
| `CATS_API_KEY` | CATS v3 key, used only to fetch resume files |
| `APP_USER`, `APP_PASSWORD` | Login for the page (sign-in form, 12-hour session). Without a password the deployed app stays locked. |
| `MOCK=1` | Sample replies without any keys, for UI testing |

## 3. Deploy

Any Node host works (Render, Railway, an internal VM). On Render: new **Web Service** from this folder's repo, build command empty, start command `npm start`, then add the variables above under **Environment**.

## How the answer format works

The agent's system prompt tells it to wrap results in markers:

```
[[SEARCH]]{"query": "...", "total": 1106}[[/SEARCH]]
[[CANDIDATES]][{"id": 399070303, "name": "...", "title": null, "city": "Vasco", "updated": "2026-07-06", "why": "..."}][[/CANDIDATES]]
```

The page turns these into the "Searched CATS" line and candidate cards. It parses leniently, since the model sometimes leaves quotes unescaped inside the query. If you edit the agent prompt, keep these markers.

## Adding modules later (employee self-help etc.)

The header already reads "HR Hub / Talent copilot". A new module is a new EKB agent (or more tools on this one) plus a module switcher in the header; `/api/chat` only needs a different `agent_id`.
