# Atrium Studio

A conversational 3D architectural workspace. Describe a building in plain
language and watch it take shape as an **editable, parametric model** — real
walls, real dimensions, real hosted openings — that you keep working in.

It is built for two people: an architect sketching an early concept, and an
architecture student learning by trying things. It is a **concept and schematic
design tool**. It does not produce permit-grade information, it does not check
your design against any building standard, and it is not a substitute for a
licensed professional. That distinction is enforced in the product, not just
written in the README.

---

## What it does

```
"Create a two-storey Scandinavian house, 12 by 8 metres."
"Make the ground-floor ceiling 2.7 metres high."
"Move the southern wall 800 millimetres outward."
"Add three evenly spaced windows to the west façade."
"Use oak flooring, white plaster walls, and dark metal window frames."
"Show the building during an overcast afternoon."
```

Each request becomes a set of **validated, typed modelling commands** applied as
one transaction. If any command fails validation, none of them apply — the scene
is never left half-built. Every change, whether it came from the chat or from
dragging a gizmo, goes through the same engine, so undo works uniformly and the
assistant always sees the design as it actually is.

The result stays parametric: a window is hosted by its wall and moves with it; a
room knows its programme and its area; raising a storey height lifts the floors
above it.

## Quick start

You need Node 22+ and either Docker or a local PostgreSQL 16.

```bash
git clone <this repository>
cd foundation-engine

cp .env.example .env          # the defaults work for local development
docker compose up -d db       # or point DATABASE_URL at your own Postgres

npm install
npx prisma migrate deploy
npm run db:seed               # demo account, sample project, reference library

npm run dev                   # http://localhost:3000
```

Sign in with **`demo@atrium.local` / `atrium-demo-2026`**, or click **Start** on
the landing page for a guest workspace.

`npm run setup` runs install, generate, migrate and seed in one step.

### No API key required

Without `ANTHROPIC_API_KEY`, the application runs its **built-in local
interpreter** — a real, deterministic natural-language rule engine, not a stub.
It handles the documented modelling operations end to end: creating footprints
and buildings, changing storey heights, moving named façades, spacing openings,
dividing floors into rooms, assigning materials, adding stairs and furniture,
setting the environment, and switching units. Everything else — persistence,
geometry, import/export, undo, the whole test suite — works exactly the same.

Ask it something outside its rules and it says so plainly and tells you a key
would unlock open-ended design conversation. Set `ANTHROPIC_API_KEY` and the
same pipeline runs against Claude instead. See [docs/ai.md](docs/ai.md).

## Commands

| Command              | What it does                                         |
| -------------------- | ---------------------------------------------------- |
| `npm run dev`        | Development server                                   |
| `npm run build`      | Production build (generates the Prisma client first) |
| `npm start`          | Serve the production build                           |
| `npm run typecheck`  | TypeScript, strict mode, no emit                     |
| `npm run lint`       | ESLint                                               |
| `npm run format`     | Prettier, writing changes                            |
| `npm test`           | Unit and integration tests (Vitest)                  |
| `npm run test:e2e`   | End-to-end tests (Playwright)                        |
| `npm run db:migrate` | Create and apply a migration                         |
| `npm run db:deploy`  | Apply migrations (production)                        |
| `npm run db:seed`    | Demo account, sample project, reference library      |
| `npm run db:studio`  | Prisma Studio                                        |

## The workspace

- **Dominant 3D viewport** with orbit, pan, zoom, perspective and orthographic
  projection, six standard views, a section cut, a ground grid and an
  orientation gizmo.
- **Conversational panel** that shows what the assistant is doing at each stage —
  reading the project, interpreting, planning, validating, applying — along with
  its operation plan, the assumptions it made, and any review findings.
- **Levels and hierarchy**, grouped the way a building is organised, with
  per-element visibility, locking and isolation.
- **Properties inspector** where every field writes a real command. Dimension
  fields accept `2400`, `2.4m`, `8'6"` or `96in`, and reject bad input visibly
  instead of silently reverting.
- **Direct manipulation**: click to select, shift-click to extend, transform
  gizmos with grid and angle snapping, measurement, duplicate, align,
  distribute, group.
- **Status bar** with selection dimensions, gross floor area, review findings,
  snap settings and live frame rate.
- **Keyboard shortcuts** throughout (`?` lists them), and panels that collapse so
  the viewport can take the whole screen.

## How it is put together

```
src/
├── domain/          Pure, framework-free core
│   ├── units/         Millimetres in, display units out
│   ├── project/       The versioned parametric model, with migrations
│   ├── commands/      The command protocol, executor, transactions, review
│   └── geometry/      Procedural geometry (no Three.js import)
├── three/           Scene adapter and React Three Fiber components
├── editor/          Client state, undo, autosave, chat, shortcuts
├── ai/              Provider interface, prompt, tools, orchestrator, interpreter
├── io/              Import and export, with a parse worker
├── knowledge/       Retrieval, chunking, untrusted-content handling
├── server/          Env, database, auth, storage, rate limiting, logging
├── components/      Design system and workspace UI
└── app/             Next.js App Router pages and API routes
```

Four rules hold the whole thing together:

1. **The project model is the source of truth**, not the Three.js scene. The
   scene is a pure function of the model.
2. **All lengths are millimetres**, everywhere, always. Display units are
   presentation only and never touch a stored number.
3. **The AI can only emit allowlisted, schema-validated commands.** There is no
   `eval`, no `new Function`, and no path from a model response to a mutation
   that skips validation. A lint rule enforces the first two; a test asserts them
   across the entire source tree.
4. **Every change is one transaction with an exact inverse.** Undo replays
   inverses; a failed transaction changes nothing.

[docs/architecture.md](docs/architecture.md) explains each layer and why it is
shaped that way.

## Import and export

**Import** — native JSON (lossless), IFC, DXF, glTF, GLB, OBJ, STL.

IFC recovers levels, straight walls, spaces and hosted openings as **real
editable elements**; everything else comes in as reference geometry, tagged by
IFC type. DXF converts straight lines on wall-named layers and brings the rest in
as reference lines. glTF, OBJ and STL carry no architectural semantics, so they
are always reference geometry.

Every import ends on a report that separates what was converted from what was
not, and says why. The product does not pretend arbitrary geometry can become
editable native elements. IFC and DXF are parsed in a Web Worker, so the viewport
stays responsive.

**Export** — native JSON (lossless, round-trips exactly), GLB, glTF, OBJ, STL,
a viewport screenshot, and a structured Markdown project summary with schedules
of spaces and openings.

## Testing

```bash
npm test          # 275 unit and integration tests
npm run test:e2e  # 10 end-to-end tests against a production build
```

Unit tests cover unit conversion and parsing, command schema validation and the
internal-command allowlist, command inversion, transaction rollback, wall panel
decomposition with hosted openings, polygon triangulation and offsetting, roof
and stair geometry, project serialisation and every migration step, the
architectural review rules, the local interpreter across the documented prompts,
scene summarisation and focus selection, retrieval chunking and prompt-injection
neutralisation, password hashing, and storage key safety.

Integration tests run against a real PostgreSQL database: project save and load,
version restore, autosave pruning, ownership boundaries in both directions, the
AI turn end to end with a scripted provider, retrieval scoping across users and
projects, and the local storage driver.

The end-to-end suite drives a production build in a real browser through the
central workflow: open a project, ask the assistant for a change, watch commands
validate and geometry appear, edit an element by hand, ask for another change,
undo and redo, reload and find the work intact, and export it.

## Security

- Server-side authorisation on every operation, scoped by owner. No handler ever
  reads an owner id from a request body.
- Sessions are opaque random tokens; only their SHA-256 is stored. Passwords use
  scrypt with self-describing parameters.
- Origin checks on all mutations, `SameSite=Lax` cookies, and a strict
  Content-Security-Policy that does not need `unsafe-eval` in production.
- Upload extension allowlists, size limits, and storage keys generated
  server-side — a client filename never reaches the filesystem or a bucket path.
- Uploaded documents are treated as untrusted: instruction-shaped patterns are
  stripped at index time, passages are delimited, and the system prompt tells the
  model they are reference material.
- Rate limiting per authenticated user, backed by Postgres so limits hold across
  instances.
- Environment variables validated at startup; secrets redacted from logs; user
  errors never carry provider or database detail.

## Documentation

- [docs/architecture.md](docs/architecture.md) — the layers and the reasoning
- [docs/ai.md](docs/ai.md) — prompt, tools, orchestration, the local interpreter
- [docs/knowledge.md](docs/knowledge.md) — retrieval, scoping, feedback
- [docs/deployment.md](docs/deployment.md) — deploying it for real
- [docs/decisions.md](docs/decisions.md) — technology choices and trade-offs
- [docs/limitations.md](docs/limitations.md) — what this build does not do

## Licence

Provided as-is for evaluation. The reference notes in the seed are original text
written for this repository and are freely reusable.
