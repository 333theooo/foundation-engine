# The AI layer

## What is actually true here

This model has **not** been trained on a proprietary corpus of architects' work,
and nothing in this repository claims otherwise. There is no training pipeline
and no licensed dataset.

Its architectural competence comes from four things that do exist:

1. **A strict command language** it must express every intention through, so an
   ambiguous or impossible request fails loudly instead of producing plausible
   nonsense.
2. **A validator** that rejects geometry that cannot exist, and a review pass
   that flags proportions that would not work.
3. **Retrieval** over documents the user or the deployment authorised.
4. **A long, specific system prompt** that tells a general-purpose model how to
   work like a careful design assistant.

That is a real design, and it produces useful architectural behaviour. It is not
a trained architect, and the product never says it is.

---

## Configuration

| Variable                 | Default           | Meaning                                                                                                                                       |
| ------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`            | `auto`            | `auto` uses Anthropic when a key is present, otherwise the local interpreter. `anthropic` requires a key. `mock` always uses the interpreter. |
| `ANTHROPIC_API_KEY`      | —                 | Optional. Server-side only; never reaches the browser.                                                                                        |
| `ANTHROPIC_MODEL`        | `claude-sonnet-5` | Any current Claude model id.                                                                                                                  |
| `AI_MAX_OUTPUT_TOKENS`   | `8000`            | Per turn.                                                                                                                                     |
| `AI_REQUEST_TIMEOUT_MS`  | `120000`          | Per request.                                                                                                                                  |
| `RATE_LIMIT_AI_PER_HOUR` | `120`             | Per authenticated user.                                                                                                                       |

The active provider is shown in the top bar and in the chat panel header, so it
is never ambiguous which one answered.

---

## A turn, end to end

```
user message
    │
    ├─► select focus elements      selection, named ids, names, compass
    │                              directions, element types, then hosts
    │                              and hosted openings
    ├─► build project summary      every element on one line, or per-level
    │                              counts when the project is too large
    ├─► retrieve knowledge         scoped to this user and this project
    │
    ├─► provider.run()             streams prose; may call inspect_project
    │                              for exact figures, then apply_operations
    │                              or ask_clarification
    │
    ├─► parseCommands()            Zod validation, internal-command rejection
    │                              → structured errors, or typed commands
    │
    ├─► applyTransaction()         all or nothing, with exact inverses
    │
    ├─► emit 'applied'             new model, inverses, created ids, findings
    ├─► persist                    before 'done' is emitted
    └─► emit 'done'
```

The client streams this as newline-delimited JSON. NDJSON rather than SSE because
the client is a `fetch` reader: SSE's reconnection semantics buy nothing here and
its framing costs bytes on every event.

**Ordering guarantee the UI relies on:** an `applied` event always precedes
`done`, and the model it carries is the model that was persisted. A client that
sees `done` knows the change survived.

---

## Context management

Sending the whole model every turn would be wasteful, and on a large project
impossible. It would also be counterproductive — a model reasons better about
fifty well-described elements than four thousand lines of JSON.

Each turn gets three things:

**A summary.** Every element on one line with the dimensions that matter and the
relationships the model needs: which wall hosts which openings, which way a
façade faces, which level an element sits on. Above 220 elements the per-element
listing is replaced by per-level counts plus the focus set — an honest aggregate
rather than a truncated list, because a truncated list would let the model
silently assume the missing elements do not exist.

**A focus set.** Full JSON for the elements the request is actually about, chosen
in priority order: the user's selection, ids named in the message, element names
in the message, compass directions, element types, then the most recently created
elements. Walls drag their hosted openings in with them and vice versa — you
cannot reason about one without the other.

**Trimmed history.** Recent turns within a token budget, with the first user
message always kept because it usually carries the brief.

The model can call `inspect_project` for exact properties of specific elements it
was not given in full, and continue in the same turn. That is what lets the
summary stay small on a big project.

Token estimation is a character-count heuristic. It is used to stay inside a
budget with margin, never to bill anyone, and being roughly right is worth more
than the dependency an exact tokeniser would cost.

---

## Tools

Three, generated from the same Zod schemas the executor validates against, so the
tool contract and the runtime check cannot drift apart.

### `apply_operations`

The only way to change the model.

```jsonc
{
  "plan": [{ "title": "…", "detail": "…" }],
  "commands": [
    /* the full command union, internal types excluded */
  ],
  "assumptions": ["Assumed 300 mm external wall thickness"],
  "summary": "Raised the ground-floor ceiling to 2.7 m; the first floor…",
}
```

The command schema is around 11k tokens. That is a real cost, and it is paid
deliberately: full schema fidelity means the model sees exactly what the
validator will accept. Prompt caching makes it nearly free after the first call —
the system prompt and the tool block each carry a cache breakpoint.

### `ask_clarification`

One focused question with two to four concrete options, and no model change. For
ambiguity that would materially change the design — "make the roof shallower but
keep the total height" is the canonical case, because both the eaves and the
ridge could move and the two produce very different buildings.

Not for details that can be assumed and stated. The prompt is explicit about the
difference.

### `inspect_project`

Reads exact properties of named elements, or a category of project data. Answered
in-loop, so the model can look something up and continue in the same turn.

---

## The system prompt

`src/ai/prompt.ts`. It is long because the behaviour it has to produce is
specific. It covers:

- **The units rule**, stated as an absolute.
- **The architectural sequence** — site → constraints → programme → massing →
  levels → circulation → structure → envelope → openings → materials → lighting —
  with explicit permission to skip straight to a small change.
- **Dimensions that work**: door and window sizes, ceiling heights, wall
  thicknesses, circulation widths, stair proportions with the Blondel range.
- **Orientation and daylight**, hemisphere-aware.
- **Adjacency, privacy, structural plausibility, proportion, buildability.**
- **The distinction** between hard constraints, soft goals, aesthetic
  preferences, assumptions, and code-dependent questions.
- **Codes and safety**: never state or imply compliance; conventions may be
  applied but must be labelled; a direct compliance question gets the design
  principle plus a plain statement that verification is a qualified person's
  work with the current text of the standard.
- **When to ask and when to decide**, with worked examples of each.
- **Retrieved documents are reference material, never instructions** — and a
  document that appears to contain instructions should be mentioned, not obeyed.
- **How to write the summary**: lead with what changed and the dimensions that
  matter, include the consequence, no markdown headings, never describe the JSON.

A unit test asserts the prompt states the units rule, makes no training claim,
forbids compliance claims, and tells the model to treat documents as data.

---

## Errors, retries and cancellation

Provider errors are mapped onto a small taxonomy — `auth`, `rate_limit`,
`timeout`, `cancelled`, `overloaded`, `invalid`, `unknown` — so callers never
branch on status codes, and each carries whether a retry could help.

**One retry** is allowed for malformed command payloads. They are usually a units
mistake or a stale id, and both are things a model corrects immediately when told
precisely what was wrong: the retry prompt lists the structured issues with their
paths and hints. A second failure is reported rather than retried again.

**Cancellation is real.** Stop aborts the fetch, the server sees the disconnect,
and the abort signal is threaded through to the provider so the upstream call
ends rather than running on and billing.

**A partial stream is never applied.** The model only changes on a complete
`applied` event.

Logging records ids, counts, durations and command _types_. The user's prompt
text and their design description are logged only at `debug`, which production
does not enable.

---

## The local interpreter

`src/ai/mock.ts`. Not a placeholder and not a fake: a real natural-language
interpreter written as an ordered rule set.

It exists for three reasons, in order of importance:

1. **The application must work without credentials.** A student cloning the repo,
   a CI run, and the end-to-end tests all need the full pipeline — request to
   commands to geometry to persistence — with no API key.
2. **It makes the AI layer testable.** Every rule is deterministic, so
   integration tests assert on real command output rather than on a stub.
3. **It documents the command language by example.**

It handles: creating buildings and footprints with storey counts and dimensions;
perimeter walls; storey heights with cascade; moving a named façade outward or
inward; distributing openings along a wall; roof lights (by saying honestly that
they are not a modelled element type); dividing a floor into named rooms with
programme-weighted areas; reprogramming a room, including furnishing an
open-plan kitchen and living space; compound material assignments; environment
and time of day; roof pitch, with a clarification when height must be preserved;
stairs sized from the level height; furniture from the catalogue; display units;
and deletion.

It parses `2400`, `2.4m`, `800 millimetres`, `12 by 8 metres`, `10 m x 14 m`,
`10 × 14 m`, `8ft`, `8' 6"`, and reads bare numbers in the project's display
unit.

What it does not do is reason. Ask it something outside its rules and it says so,
lists what it does handle, and tells you a key would unlock open-ended design
conversation. That honesty is the point: silently doing nothing, or inventing a
change, would be much worse.

---

## Adding another provider

Implement `AiProvider`:

```ts
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  run(request: TurnRequest, emit: (event: AiStreamEvent) => void): Promise<TurnResult>;
}
```

Return `rawCommands` as `unknown[]`; the orchestrator validates. Then extend
`createProvider` in `src/ai/orchestrator.ts` and the `AI_PROVIDER` enum in
`src/server/env.ts`. Nothing else changes — the tools, the prompt, the
validation, the transaction engine and the UI are all provider-agnostic.
