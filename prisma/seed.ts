/**
 * Database seed.
 *
 * Creates a demo account with the sample project, plus a small library of
 * architectural reference notes so retrieval has something to retrieve out of
 * the box.
 *
 * Everything here is idempotent: running it twice updates rather than
 * duplicates, so `npm run db:seed` is safe on an existing database.
 *
 * The library documents are original text written for this repository. Nothing
 * is copied from a standard or a copyrighted source, and every passage is
 * phrased as guidance rather than as a requirement — which is the same
 * distinction the product makes everywhere else.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { hashPassword } from '../src/server/auth/password';
import { buildSampleProject } from '../src/domain/project/sample';
import { chunkDocument } from '../src/knowledge/chunk';
import { createEmbeddingProvider, termFrequencies } from '../src/knowledge/embedding';
import { PROJECT_SCHEMA_VERSION } from '../src/domain/project/schema';

const DEMO_EMAIL = 'demo@atrium.local';
const DEMO_PASSWORD = 'atrium-demo-2026';

const LIBRARY_DOCUMENTS: Array<{ title: string; source: string; body: string }> = [
  {
    title: 'Schematic dimensions — a working reference',
    source: 'Atrium Studio reference notes',
    body: `# Schematic dimensions

These are working figures for early design. They are conventions in common use, not requirements. Every jurisdiction sets its own standards, and those standards change; check yours before relying on any number here.

## Doors

A single internal door is typically 800–900 mm wide and 2000–2100 mm high. Where a route needs to be step-free, 800 mm of clear opening width is a common minimum and 850–900 mm is more comfortable. An entrance door is usually 900–1100 mm wide. Double doors are typically 1500–1800 mm overall.

Head heights are usually aligned across a room: setting door heads and window heads to the same level is a simple move that makes an elevation read as considered rather than accidental.

## Windows

Sill heights of 850–950 mm suit rooms where people stand and look out; 400–500 mm suits a room where they sit. A floor-to-ceiling opening starts at 0–200 mm and runs to just below the ceiling.

Glazing area is often expressed as a proportion of floor area. Somewhere between 15% and 25% is a common range for habitable rooms in temperate climates — enough daylight without excessive heat loss or summer gain.

## Ceiling and storey heights

Domestic ceiling heights of 2400 mm are ordinary, 2700 mm feels generous, and 3000 mm reads as a room with ambition. Floor-to-floor height is the ceiling height plus the floor construction: add 300–450 mm for a timber floor and 250–350 mm for a concrete slab.

Many jurisdictions set a minimum habitable ceiling height around 2300–2400 mm.

## Circulation

A corridor serving rooms wants at least 900 mm clear, and 1200 mm if it is a main route or needs two people to pass. A wheelchair turning circle is commonly taken as 1500 mm diameter.

## Walls

External walls of 250–400 mm cover most constructions once insulation is included. Internal partitions are usually 100–150 mm. A wall's height-to-thickness ratio above about 40:1 needs restraint or a thicker section.
`,
  },
  {
    title: 'Stair proportioning',
    source: 'Atrium Studio reference notes',
    body: `# Stair proportioning

## Blondel's rule

The relationship between riser and going that produces a comfortable stair is usually expressed as:

    2 × riser + going = 600 to 640 mm

Anything between 550 and 700 mm will generally walk acceptably. Outside that range the stair fights the natural stride.

This is a proportioning convention with a long history, not a regulation.

## Typical figures

A domestic private stair commonly uses a 180–190 mm riser with a 250–280 mm going. A public or shared stair uses a shallower 150–170 mm riser with a 280–300 mm going, because it carries more people and more varied ability.

## Setting out

Divide the floor-to-floor rise by a target riser height and round to a whole number of risers, then divide back to get the exact riser. A flight of N risers has N − 1 treads; the upper floor provides the last one.

A straight flight of N risers occupies (N − 1) × going in plan. If that does not fit, an L-shaped or U-shaped flight with a landing will — allow at least the stair width for the landing depth.

## Width and headroom

800 mm is a common minimum width for a private stair, 1000 mm is comfortable, and 1200 mm suits a main stair in a shared building. Headroom of 2000 mm measured vertically from the pitch line is a widely used minimum.
`,
  },
  {
    title: 'Orientation, daylight and solar gain',
    source: 'Atrium Studio reference notes',
    body: `# Orientation, daylight and solar gain

## Northern hemisphere

South-facing glazing receives the most solar radiation over a year, and the winter sun is low enough to reach deep into a room. That makes south the orientation of choice for living spaces in a heating-dominated climate — with shading to control the high summer sun, which a modest overhang handles well because the geometry differs so much between seasons.

North-facing glazing receives no direct sun and delivers even, consistent light with very little glare. It is what studios and drawing offices have always wanted, and it is the right orientation for spaces where consistency matters more than warmth.

East glazing takes the morning sun; west glazing takes the afternoon sun at a low angle that is hard to shade and can badly overheat a room in summer. West-facing glass wants shutters, deep reveals, or restraint.

In the southern hemisphere, exchange north and south throughout.

## Depth of daylight

As a rule of thumb, useful daylight from a side window reaches about 2 to 2.5 times the window head height into a room. A room 6 m deep with a 2.1 m head height will be gloomy at the back unless it is lit from more than one side or from above.

## Programme and orientation

Put the spaces that reward sunlight — living, kitchen, dining — where the sun is. Put the spaces that do not need it — stores, plant, circulation, utility — on the cold or overlooked side, where they also act as a thermal buffer.
`,
  },
  {
    title: 'Structural plausibility at concept stage',
    source: 'Atrium Studio reference notes',
    body: `# Structural plausibility at concept stage

These are order-of-magnitude checks for testing whether a massing idea is buildable. They are not design. Sizing structure requires a qualified engineer working with real loads, real materials and the applicable standards.

## Span-to-depth ratios

As a first approximation, a member's depth is a fraction of its span:

- Timber joist: span / 20
- Steel beam: span / 20 to span / 25
- Reinforced concrete beam: span / 12 to span / 15
- One-way concrete slab: span / 25 to span / 30
- Flat slab: span / 30

So a 6 m timber-joisted floor wants joists around 300 mm deep, and a 9 m steel span wants a beam around 400 mm.

## Load paths

Loadbearing walls should continue down through the building to the foundation. A wall that appears on an upper floor with nothing beneath it needs a beam and a pair of columns, and that beam will be deep — check that the ceiling can accommodate it before committing to the plan.

Wet areas stacked between floors shorten every service run and simplify the structure around them.

## Columns

A column's slenderness — its height divided by its least dimension — is a reasonable sanity check. Above roughly 30:1, restraint at an intermediate level or a larger section is likely to be needed. The real limit depends on material, end fixity and load.
`,
  },
];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env before seeding.');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    /* ------------------------------ Demo account ----------------------------- */

    const passwordHash = await hashPassword(DEMO_PASSWORD);
    const user = await prisma.user.upsert({
      where: { email: DEMO_EMAIL },
      create: {
        email: DEMO_EMAIL,
        name: 'Demo Architect',
        passwordHash,
        settings: { units: 'metric', defaults: { wallThickness: 300, storeyHeight: 2700 } },
      },
      update: { passwordHash },
    });
    console.log(`✓ Demo account: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);

    /* ----------------------------- Sample project ---------------------------- */

    const model = buildSampleProject({ name: 'Lakeside Studio' });
    const existing = await prisma.project.findFirst({
      where: { ownerId: user.id, name: 'Lakeside Studio' },
      select: { id: true },
    });

    const project = existing
      ? await prisma.project.update({
          where: { id: existing.id },
          data: {
            model: model as unknown as object,
            elementCount: Object.keys(model.elements).length,
            schemaVersion: PROJECT_SCHEMA_VERSION,
          },
        })
      : await prisma.project.create({
          data: {
            ownerId: user.id,
            name: model.name,
            description: model.description,
            model: model as unknown as object,
            elementCount: Object.keys(model.elements).length,
            schemaVersion: PROJECT_SCHEMA_VERSION,
          },
        });

    const conversation = await prisma.conversation.findFirst({ where: { projectId: project.id } });
    if (!conversation) await prisma.conversation.create({ data: { projectId: project.id } });

    const hasVersion = await prisma.projectVersion.findFirst({ where: { projectId: project.id } });
    if (!hasVersion) {
      await prisma.projectVersion.create({
        data: {
          projectId: project.id,
          label: 'Sample project as seeded',
          kind: 'MANUAL',
          model: model as unknown as object,
          revision: model.revision,
        },
      });
    }
    console.log(
      `✓ Sample project "${model.name}" with ${Object.keys(model.elements).length} elements`,
    );

    /* --------------------------- Knowledge library --------------------------- */

    const embedder = createEmbeddingProvider();
    for (const document of LIBRARY_DOCUMENTS) {
      const existingDocument = await prisma.knowledgeDocument.findFirst({
        where: { scope: 'LIBRARY', title: document.title },
        select: { id: true },
      });
      if (existingDocument) {
        await prisma.knowledgeChunk.deleteMany({ where: { documentId: existingDocument.id } });
        await prisma.knowledgeDocument.delete({ where: { id: existingDocument.id } });
      }

      const chunks = chunkDocument(document.body);
      const vectors = await embedder.embed(chunks.map((chunk) => chunk.content));

      const created = await prisma.knowledgeDocument.create({
        data: {
          scope: 'LIBRARY',
          status: 'INDEXED',
          title: document.title,
          source: document.source,
          licence: 'Written for this repository; freely reusable.',
          mimeType: 'text/markdown',
          sizeBytes: Buffer.byteLength(document.body),
        },
      });

      await prisma.knowledgeChunk.createMany({
        data: chunks.map((chunk, index) => ({
          documentId: created.id,
          ordinal: chunk.ordinal,
          content: chunk.content,
          embedding: vectors[index] ?? [],
          terms: termFrequencies(chunk.content),
          tokens: chunk.tokens,
          headings: chunk.headings,
        })),
      });

      console.log(`✓ Indexed "${document.title}" (${chunks.length} chunks)`);
    }

    console.log('\nSeed complete. Sign in at /sign-in with the demo credentials above.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
