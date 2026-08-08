# CLAUDE.md

This project's contributor guidance lives in [AGENTS.md](AGENTS.md) — read Part 2 before
changing code, and Part 1 if you are using the CRM rather than building it.

Quick reference:

```bash
npm run check              # format + typecheck + web build + tests — must pass before committing
npm test                   # tests only
npm run dev                # server with auto-restart
npm run build:web          # rebuild the browser bundle after editing src/web/
npm run cli -- selfcheck   # diagnose a local instance
npm run smoke              # end-to-end against a running server
```

The server runs TypeScript directly through Node's type stripping — there is no server build
step. Imports must use explicit `.ts` extensions.
