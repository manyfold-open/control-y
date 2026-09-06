# Ctrl+Y

English · [中文](README_CN.md)

A fund manager sends a deliverable out for review and gets it back with comments.
Then again. Then again. Ctrl+Y collapses that loop: a panel of agents reads the
deliverable against its source documents, a consolidator merges what they found into
one list of issues, each issue is assigned to the one person who can answer it, and
the replies are pasted back so the panel can run again.

The product's only number is the count of open issues after each pass — 18, then 14,
then 12, then zero.

## How a review runs

1. **Give it the documents.** The deliverable, plus whatever governs it: the
   partnership agreement, side letters, portfolio activity, the master lists.
2. **Run a pass.** Every enabled agent reads the documents on its own — one turn
   each, no shared context, so one agent's reading cannot colour another's. The
   consolidator then receives all of their findings at once and returns one merged,
   assigned, drafted list of issues.
3. **Work the list.** An issue says what is wrong and why it matters, quotes the
   evidence it rests on, and names the person who has to answer it. Where the panel
   disagreed, the disagreement and the ruling are both shown. Everything one person
   has to answer copies out as a single letter.
4. **Paste the replies back.** The consolidator reads each reply against the open
   issues and proposes links — this resolves it, this answers part of it, this
   contradicts it. You accept or reject each one.
5. **Run the next pass.** Answered issues fall away, rewritten ones say what changed,
   new ones are marked new.
6. **Close the review.** A retrospective writes the close-out — what went well, what
   to change — and proposes rules to carry into the next period. Each rule is written
   into memory switched off, so it applies only once you switch it on.

## The workspace

- **Reviews** — every review, newest first, with its pass counts beside it.
- **People** — the directory, and each person's title on the review in progress.
  Assignment reads the title rather than the job role, so the title is what you edit.
- **Memory** — what carries between reviews: a *Treatment* already agreed with the
  counterparty, a *Pattern* that recurs, an *Instruction* of yours, a *Fact* about the
  fund. An entry applies when it is switched on and in scope on the review being run.
- **Agents** — the panel itself. Each agent is a prompt with one job: four reviewers
  ship with the app, alongside the one consolidator and the one retrospective. The
  prompts are the configuration surface — there are no switches for tie-break rules.
- **Connections** — the Manyfold agents the panel runs on. Connecting is a device-code
  handshake: a popup opens Manyfold's consent page, you compare the confirmation code
  and pick which agents to share. Tokens are encrypted at rest and never reach the
  browser.

A new workspace opens with one review in progress and two already closed, because an
empty worklist teaches nothing. It is ordinary data from the moment it lands — edit
it, re-run it, delete it.

## Running it

Requires Node 22+, a Cloudflare account, and at least one Manyfold agent for the panel
to run on.

```bash
npm install
npm run dev
```

That serves the React app, the Worker and a local D1 database together on
http://localhost:5173. The schema is applied on the first request; there is no
migration step. Copy `.dev.vars.example` to `.dev.vars` for the optional settings.

| Command | What it does |
| --- | --- |
| `npm run dev` | App + worker + local D1 |
| `npm run check` | Typecheck, build, `wrangler deploy --dry-run` |
| `npm test` | Unit tests (vitest) |
| `npm run deploy` | Manual deploy |
| `npm run smoke -- <url>` | Smoke-test a deployment |

### Deploying your own copy

Every push to `main` builds (`npm run build`) and deploys (`npx wrangler deploy`)
through Cloudflare Workers Builds. A fork needs its own resources in `wrangler.jsonc`:

- a D1 database — `npx wrangler d1 create <name>`, then paste the returned
  `database_id`;
- two R2 buckets for uploaded documents, production and `-dev`. Without them the app
  still runs and text files go in as prompt material; anything binary is refused, with
  a message saying so;
- the `routes` block, which points at `ctrl-y.manyfold.ai`. Replace it with your own
  hostname, or delete it and set `workers_dev: true`.

Then set the secrets you want:

```bash
npx wrangler secret put ADMIN_PASSWORD          # recommended: otherwise anyone with the URL can run — and bill — your agents
npx wrangler secret put CONFIG_ENCRYPTION_KEY   # optional: keeps the encryption key out of the database
npx wrangler secret put R2_ACCESS_KEY_ID        # with R2_ACCOUNT_ID and R2_SECRET_ACCESS_KEY, for uploads
```

Verify a deployment with `npm run smoke -- <url>`, or `GET /api/health`.

## How it is built

Vite + React 19 in the browser, Hono on a single Cloudflare Worker, D1 for state, R2
for documents, Manyfold agents over A2A.

| File | Purpose |
| --- | --- |
| `src/worker/panel.ts` | Running a pass: every reviewer, then the consolidator |
| `src/worker/routes.ts` | The API — reviews, issues, people, memory, documents |
| `src/worker/store.ts` | Every D1 read and write behind those routes |
| `src/worker/connect.ts` | The Manyfold handshake and the connected-agent store |
| `src/app/views/` | The screens |

Agent tokens are AES-GCM encrypted in D1 and never reach the browser, connectivity
checks use a probe that does not bill, and agent-supplied URLs are validated before
use. `AGENTS.md` lists the invariants to preserve while iterating, `PRODUCT.md` says
what the product is for, and `DESIGN.md` how it should look.

## License

[MIT](LICENSE)
