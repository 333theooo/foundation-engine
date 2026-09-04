# Architecture

This document explains what each layer does and, more usefully, why it is shaped
the way it is. The interesting decisions are the ones about boundaries.

---

## The one idea

**The project model is the source of truth. Everything else is derived.**

```
                   ┌──────────────────────────────┐
   chat ──────────►│                              │
                   │      ProjectModel (JSON)     │──────► Three.js scene
   gizmo drag ────►│   versioned · serialisable   │        (pure function)
                   │   millimetres · semantic     │
   inspector ─────►│                              │──────► exporters
                   └──────────────────────────────┘
                              ▲     │
                              │     ▼
                        commands  inverses
```

Nothing writes to the scene graph. Nothing reads design state out of it. A Three
mesh is a rendering artefact with a lifetime of one geometry fingerprint; the
model is what gets saved, versioned, summarised for the AI, and reloaded.

This is why a manual gizmo drag and an AI operation are indistinguishable
downstream: both produce commands, both go through the same executor, both land
on the same undo stack, and both are visible to the assistant on the next turn.

## Layers

### `src/domain` — pure core

No React, no Three.js, no database, no `window`. It runs unchanged in Node, in a
Web Worker and in the browser, which is what makes it straightforward to test.

**`units/`** — The invariant the whole codebase rests on: every stored length is
millimetres. Millimetres are what architects detail in, they keep building
dimensions inside exact-integer float range, and they avoid the drift you get
from accumulating metres. Conversion happens only at boundaries: on input (AI
commands, form fields, importers) and on output (labels, exporters, the scene).
Switching a project to imperial changes not one stored number.

**`project/`** — The versioned model. `schema.ts` is a Zod discriminated union of
twelve element types, plus levels, materials, environment, saved views,
constraints and measurements. `limits.ts` holds the hard numeric guard rails —
coordinate range, dimension range, element caps — that stop a malformed response
or a corrupt import producing NaN geometry or a 40 GB buffer.

`migrations.ts` is a forward-only chain. Each step upgrades by exactly one
version and is individually tested. A saved project always reloads into the same
geometry, including one written by an older build. Loading also repairs what the
schema alone cannot express: missing hierarchy order, stale entries, openings
whose host wall has gone.

**`commands/`** — The modelling protocol, and the security boundary. Covered in
its own section below.

**`geometry/`** — Procedural geometry as pure numeric functions: millimetres in,
scene metres out. The generators return vertex buffers, never Three objects, so
they run in the worker and on the server for export.

### `src/three` — the scene adapter

`SceneAdapter` is a cache, not a scene graph. React owns the graph; the adapter
owns the expensive GPU resources and their lifetimes.

Geometry is keyed by `geometryKey(model, element)` — a fingerprint of exactly the
fields that affect vertices. Renaming an element, selecting it, or orbiting the
camera rebuilds nothing. A wall's key includes its openings' geometry, because a
hosted opening changes the wall solid.

`collectGarbage` disposes anything not touched in the last pass. Three.js does
not reference-count GPU resources; without this, an hour of editing leaks every
intermediate wall.

Textures are generated procedurally on a canvas — no binary assets in the repo,
nothing to fetch, and tiling defined in millimetres so a brick reads at the right
size on any wall.

### `src/editor` — client state

A Zustand store holding the model plus the ephemeral state that lives only in the
tab: selection, hover, camera, gizmo mode, snapping, panel layout, undo stack.

`dispatch` is the only way the model changes. It parses, applies transactionally,
pushes the inverse onto the undo stack, records an operation log entry, and marks
the project dirty. `replaceModel` installs a model produced elsewhere — an AI
turn, a version restore — with its inverse commands, so an AI change is undone
exactly like a manual one.

Autosave has three layers because each fails differently: a debounced server save
(durable), a `localStorage` draft written on every change (covers the gap between
an edit and its save), and a `sendBeacon` flush on page hide (covers a closed
tab). On load, a draft strictly newer than the server's revision is offered back
rather than silently applied.

### `src/ai` — the AI boundary

A provider takes a turn request and yields events. It never touches the model,
never applies anything, and never returns code. Swapping Claude for another model
means implementing `AiProvider` and nothing else.

The orchestrator is the interaction model in one function: read project state,
interpret, plan, generate commands, validate, apply transactionally, stream, and
summarise. Everything a provider returns is `unknown[]` until `parseCommands`
turns it into typed commands or into structured errors.

### `src/io` — import and export

Format routing reflects what each parser actually needs. IFC and DXF are the
expensive ones and run in a Web Worker with transferable buffers. OBJ and STL are
parsed there too — implemented directly rather than pulling a DOM-dependent
loader into a worker. glTF stays on the main thread because `GLTFLoader` needs
the DOM for its texture path, and its loader is imported lazily so three.js
example code is not in the initial bundle.

### `src/knowledge` — retrieval

Documents are chunked on headings first, so a retrieved passage arrives with the
section it came from. Retrieval is hybrid: cosine similarity over an embedding
plus term overlap.

The default embedder is local, deterministic and **lexical** — hashed n-grams and
tokens, L2-normalised. It is not a neural embedding and does not capture
semantics. It is chosen because it is honest about that, needs no credentials, is
deterministic (so retrieval tests are stable), and paired with term overlap it
does the job the product needs: find the passage in the user's own documents that
mentions the thing they asked about. `EmbeddingProvider` is the seam — see
[knowledge.md](knowledge.md).

### `src/server` — infrastructure

Environment validated once at import, so a misconfigured deployment fails at boot
with a readable list rather than deep inside a request. Prisma through a driver
adapter. Structured logging with redaction. Postgres-backed rate limiting.
Storage behind one interface with two real drivers.

Every API route goes through `route()`, which makes the security properties
uniform rather than a matter of per-endpoint discipline: origin check on
mutations, session resolution, rate limits keyed to the authenticated user, and
one consistent error shape whose public message is always ours.

---

## The command system

This is the part that makes the product safe to point a language model at.

### The protocol

`ModelingCommand` is a Zod discriminated union of 62 command types covering
creation, editing, transforms, levels, materials, environment, lighting, views,
measurement, project settings, constraints, import/export and snapshots.

Every command carries a stable id, a protocol version, a type, validated
arguments, target ids where applicable, and a human-readable description.

Conventions every command obeys, without exception:

- **All lengths are millimetres.** No unit field, no ambiguity.
- **All angles are degrees**, plan rotation anticlockwise from east.
- **Plan coordinates are `{ x: east, y: north }`**, elevation separate.

### Two layers of allowlisting

Nine command types are **internal**: `restore_elements`, `replace_levels`,
`remove_elements_hard`, `replace_materials`, `replace_environment`,
`replace_views`, `replace_constraints`, `replace_measurements`,
`replace_project_info`. They exist so the engine can express an exact inverse.

They are excluded from the tool schema the model sees, _and_ rejected by
`parseCommands` if one arrives anyway. Two independent layers, because a tool
schema is a hint and a validator is a guarantee. A test asserts both.

The furniture catalogue is allowlisted the same way: `place_furniture` accepts
only ids that exist in the internal catalogue, so a model response can never
cause arbitrary geometry to be constructed.

### Transactions

The rule the product depends on: **the scene is never left half-built.**

`applyTransaction` clones the model, applies each command to the draft, and only
publishes the draft once every essential command has succeeded. There is no
partial-write path to get wrong. On failure the returned model is the input _by
reference_, so a caller can compare identity to detect a no-op.

"Essential" is per-command: a `set_camera` that fails should not roll back a
successful wall. `optionalCommandIds` marks those.

### Inverses

Each command returns the commands that undo it, and they are exact rather than
approximate:

| Command                     | Inverse                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| any `create_*`              | `remove_elements_hard` with the created ids                              |
| `delete_elements`           | `restore_elements` with the full elements and their hierarchy positions  |
| `set_element_properties`    | the same command with the previous values, one per target                |
| `move` / `rotate` / `scale` | a snapshot restore of the geometric fields                               |
| `update_level` (cascading)  | `replace_levels` plus per-wall height restores                           |
| `split_wall`                | remove the new segment, restore the original, re-host the moved openings |
| `group_elements`            | `ungroup_elements`                                                       |

Undo replays inverses in reverse order; the inverse of an inverse is the redo.
Round-trip fidelity is asserted in tests down to element JSON and hierarchy
order.

### Validation and review

Two distinct things, deliberately separated.

**Validation** blocks. Schema violations, missing references, geometry that
cannot exist (an opening past the end of its wall, a zero-length wall, a
non-existent host), and limit breaches all reject the transaction.

**Review** advises. `validateModel` runs after every transaction and produces
findings: stairs outside the comfortable Blondel range, slender walls, low
ceilings, narrow doors, façades that are almost entirely opening, levels sharing
an elevation, breached project constraints.

Findings never block. Every finding that restates a convention rather than a
geometric fact carries a `conventionSource` explaining that it is guidance, and
the UI shows it. This is the product's most important honesty boundary: it
applies widely-used rules of thumb and says so, and it never presents any of it
as a code check.

---

## Wall geometry, and why it works this way

Walls with openings are the hardest geometry problem here, and the obvious answer
— CSG booleans — is the wrong one. Boolean libraries are fragile on
near-coplanar faces, slow enough to feel it when dragging, and when they fail
they fail silently.

Instead the wall is treated as a rectangular elevation in local `(u, v)`
coordinates, punched with axis-aligned rectangular holes:

1. Collect every hole edge as a u-cut and a v-cut.
2. The cuts define a grid; a cell is solid iff its centre is outside every hole.
3. Merge solid cells horizontally into spans, then merge identical spans
   vertically.

The result is exact (holes are axis-aligned by construction), watertight, cheap,
and produces geometry a person can reason about: a wall with one window becomes
four panels — under, over, and either side. Tests assert the panel layout
directly, and that the panels tile the wall minus the holes to within a
millimetre.

Openings that overrun their wall are **clamped** rather than rejected, so
shortening a wall does not fill the viewport with NaNs; the review separately
reports that they no longer fit.

Gable roofs need one more idea. The fold along the ridge means the top surface
cannot be triangulated as a single polygon — an ear spanning both slopes would
cut straight through the fold. Each slope is clipped out with a half-plane clip
and triangulated on its own, and perimeter edges crossing the ridge are
subdivided so the fascia follows the fold. (The first implementation missed this,
and produced a gable with no ridge at all. The test that caught it is in
`tests/unit/geometry.test.ts`.)

---

## Performance

Targets a normal modern laptop at interactive frame rates, through five
decisions:

1. **No React state update per frame.** The FPS counter samples at 2 Hz. Nothing
   else is driven by the render loop.
2. **`frameloop="demand"`.** The renderer draws when something changes, not
   sixty times a second at rest.
3. **Geometry cached by fingerprint.** Camera movement, selection and renaming
   rebuild nothing.
4. **The gizmo previews on the GPU.** Dragging moves a wrapper group; a command
   is dispatched once, on release. Dragging a wall does not run the command
   engine sixty times a second.
5. **Instancing for repeated elements.** Furniture is drawn with `InstancedMesh`
   grouped by catalogue item and scale — twenty identical chairs are one draw
   call. A selected or hovered piece falls back to an individual mesh so it can
   carry an outline.

Plus explicit disposal, lazy loading of exporters and loaders, worker-based
parsing, and hard caps: 5,000 elements per project, 400 per AI turn, 300 commands
per transaction. The status bar shows element count, draw calls, triangles and
frame rate, and warns as the caps approach.

---

## Data model

The project model is stored as JSONB in `Project.model`. It is a single versioned
document with its own migration chain, and splitting it into relational tables
would buy nothing: nothing queries inside a design, and a partial write is
exactly the failure mode the transaction engine exists to prevent.

Everything else is relational: users, sessions, projects, versions,
conversations, messages, operations, feedback, knowledge documents and chunks,
assets, rate-limit hits. Every user-owned row carries `ownerId` so authorisation
is a single indexed predicate rather than a join walk, and deletes cascade from
the owner outwards so account deletion is complete.

`Operation` records the request, the scene summary the model was given, the
commands it produced, the validation result and the outcome. That is deliberately
the shape a reviewed fine-tuning set would need — but nothing trains on it. See
[knowledge.md](knowledge.md).
