# Technology decisions

Where this repository departs from the obvious choice, here is the reasoning.

## TypeScript 5.9, not 7.0

TypeScript 7 is released, but the surrounding tooling — `typescript-eslint`,
Next's type plugin, Vitest's transform — has had far less exposure to it. This
project is large enough that a subtle type-checker difference would cost more
than the compile-speed gain is worth. 5.9 in strict mode, with
`noUncheckedIndexedAccess` and `noImplicitOverride` on.

## Prisma 7.10, not the 8.0 release candidate

npm's `latest` tag for Prisma currently points at `8.0.0-rc`. Release candidates
do not belong in a project meant to be run. 7.10 is the stable line, and it is
where the driver-adapter model settled.

Prisma 7 moved the connection URL out of `schema.prisma` into a driver adapter,
which is why there is a `prisma.config.ts` and why `src/server/db.ts` constructs
`PrismaPg` explicitly. The connection string therefore lives in exactly one
place: the validated environment.

## Hand-rolled session authentication, not NextAuth

Auth.js v5 — the version built for the App Router — is still beta. Auth.js v4
predates the App Router and needs adapters and workarounds to fit.

What this application actually needs is narrow: email and password, server-side
sessions, and an ownership check on every operation. That is roughly 200 lines
using only Node's standard library, and it is fully tested:

- **scrypt** for password hashing. Memory-hard, in Node's standard library, no
  native build step — which is a common source of deployment failures. Stored
  parameters are self-describing (`scrypt$N$r$p$salt$hash`) so they can be raised
  later without invalidating existing hashes.
- **Opaque random session tokens**, not JWTs. A database session can be revoked
  the instant a user signs out or an account is deleted; a stateless token
  cannot. Only the SHA-256 of the token is stored, so a database leak does not
  hand an attacker working sessions.
- **`SameSite=Lax`, `HttpOnly`, `Secure` outside development**, plus an Origin
  check on every mutation. That is cheaper and harder to get wrong than a
  per-form CSRF token, and needs no synchronised secret.

If a deployment needs SSO, the seam is `src/server/auth/index.ts`: replace
`authenticate` and `registerUser`, and everything downstream is unchanged.

## No CSG library for wall openings

Boolean geometry libraries are fragile on the near-coplanar faces that
architectural models are full of, slow enough to feel when dragging, and they
fail silently.

Because openings are axis-aligned rectangles in wall-local space, a grid
decomposition is exact and roughly free. See
[architecture.md](architecture.md#wall-geometry-and-why-it-works-this-way).

## Ear clipping in-repo, not a tessellation dependency

Architectural outlines are small — tens of points. Ear clipping is O(n²) but
exact and dependency-free, and having the algorithm in the repository means a
degenerate outline produces a diagnosable failure instead of a mystery crash
inside a black box.

## A lexical embedder by default

Anthropic does not offer an embeddings endpoint, so a neural embedding would mean
a second provider and a second credential. The default is a local, deterministic
lexical embedder: hashed character n-grams, tokens and bigrams, L2-normalised.

It does not capture semantics — "daylight factor" and "natural illumination" will
not land near each other. It is chosen anyway because it is honest about being
lexical, needs no credentials, is deterministic (so retrieval tests are stable),
and paired with the term-overlap half of hybrid retrieval it does what a
schematic design tool needs: find the passage in the user's own documents that
mentions the thing they asked about.

`EmbeddingProvider` is the seam. Point it at Voyage, OpenAI or a local model
server and retrieval quality improves with no other change.

## Embeddings in JSONB, not pgvector

pgvector is not available in every managed Postgres, and at the scale a design
tool's knowledge base reaches — hundreds to low thousands of chunks per
deployment — an in-process cosine over JSONB arrays is comfortably fast.

The upgrade path is contained: add the extension, change the `embedding` column
type, and replace the scoring loop in `retrieveKnowledge` with an index scan.
Nothing else touches embeddings.

## Postgres-backed rate limiting, not Redis

Keeps the required infrastructure to one service while still holding limits
across multiple app instances, which an in-memory counter would not. The volume
is one row per accepted request, pruned opportunistically on write — negligible
next to the AI call it is protecting.

The limiter fails **open**: if the database is unreachable the request is allowed
and the failure logged, because a rate limiter that fails closed would take the
whole application down with the database, and the outage is the real incident.

## NDJSON, not Server-Sent Events

The client is a `fetch` reader, not an `EventSource`. SSE's reconnection
semantics buy nothing here — a dropped AI stream should not silently resume — and
its framing costs bytes on every event.

## Reference geometry re-parsed on load, not stored

An imported IFC can be tens of megabytes. Storing its geometry in the project
model would make a document that has to load quickly and diff cleanly enormous.

Instead the model stores an `assetRef` and the original file is kept in object
storage; reference geometry is re-parsed on load and cached for the session.

The trade-off, stated plainly: a project with a large IFC import takes a few
seconds longer to become complete on reload. In exchange the project document
stays small, the source file remains authoritative, and the user can always see
exactly which file their reference geometry came from.

## Furniture from a fixed catalogue

`place_furniture` accepts only ids that exist in the internal catalogue. This is
a security boundary as much as a design one: an allowlisted catalogue means a
model response can never cause arbitrary geometry to be constructed. Every item
carries real-world dimensions, so a placed sofa is a check on whether the room
works rather than decoration.

## Procedural textures

Generated on a canvas at runtime. No binary assets in the repository, nothing to
fetch (the CSP blocks third-party images anyway), and tiling is defined in
millimetres so a brick reads at the right size on any wall.

## React Compiler lint rules disabled only in `src/three`

The React Compiler's immutability rules model a pure-render world. The Three.js
integration is deliberately imperative: `camera`, `gl` and the controls instance
all come from `useThree()` and are meant to be mutated — that is how
react-three-fiber works, and there is no declarative alternative for moving a
camera or setting a clipping plane.

The rules stay on everywhere else, and the violations they found in the UI layer
were real bugs that have been fixed — including a transform gizmo that read a ref
during render and would not have attached until something else forced a
re-render.
