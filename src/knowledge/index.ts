import { prisma } from '@/server/db';
import { logger } from '@/server/logger';
import { MAX_DOCUMENT_BYTES } from '@/domain/project/limits';
import type { SessionUser } from '@/server/auth/session';
import type { Citation } from '@/ai/types';
import { chunkDocument, decodeDocument, delimitPassage, neutraliseUntrustedText } from './chunk';
import { cosineSimilarity, createEmbeddingProvider, termFrequencies, tokenize } from './embedding';

export * from './chunk';
export * from './embedding';

/**
 * Retrieval-augmented architecture knowledge.
 *
 * Scope rules, which are the part that matters for a multi-tenant product:
 *
 *   * `LIBRARY` — general reference shipped with the deployment. Visible to
 *     everyone.
 *   * `USER` — a person's own uploads, across their own projects.
 *   * `PROJECT` — attached to one project.
 *
 * A retrieval never crosses an owner boundary. One customer's private documents
 * cannot inform another customer's session, and nothing a user uploads is used
 * to improve anyone else's experience. That is enforced here, in the query, not
 * by convention elsewhere.
 *
 * Retrieval is hybrid: cosine similarity over the embedding plus term overlap.
 * With a lexical embedder the two agree often, but term overlap rescues exact
 * matches on rare terms ("Part M", "U-value") that hashing can dilute.
 */

export interface IngestInput {
  title: string;
  source: string;
  licence: string;
  mimeType: string;
  bytes: Uint8Array;
  scope: 'USER' | 'PROJECT';
  projectId?: string | null;
}

export interface IngestResult {
  documentId: string;
  chunks: number;
  /** Injection-shaped patterns removed while indexing. Reported to the user. */
  sanitisedPatterns: number;
  warnings: string[];
}

export async function ingestDocument(user: SessionUser, input: IngestInput): Promise<IngestResult> {
  if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `Documents are limited to ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB. That file is ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB.`,
    );
  }

  if (input.projectId) {
    const owned = await prisma.project.findFirst({
      where: { id: input.projectId, ownerId: user.id },
      select: { id: true },
    });
    if (!owned) throw new Error('That project does not exist.');
  }

  const warnings: string[] = [];
  const raw = decodeDocument(input.bytes, input.mimeType, input.title);
  const { text, removed } = neutraliseUntrustedText(raw);
  if (removed > 0) {
    warnings.push(
      `${removed} instruction-like pattern(s) were removed while indexing. Uploaded documents are treated as reference material, never as instructions.`,
    );
  }

  const chunks = chunkDocument(text);
  if (chunks.length === 0) {
    throw new Error('That document had no readable text.');
  }

  const document = await prisma.knowledgeDocument.create({
    data: {
      ownerId: user.id,
      projectId: input.projectId ?? null,
      scope: input.scope,
      status: 'PENDING',
      title: input.title.slice(0, 200),
      source: input.source.slice(0, 400),
      licence: input.licence.slice(0, 200),
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
    },
  });

  try {
    const embedder = createEmbeddingProvider();
    const vectors = await embedder.embed(chunks.map((chunk) => chunk.content));

    await prisma.knowledgeChunk.createMany({
      data: chunks.map((chunk, index) => ({
        documentId: document.id,
        ordinal: chunk.ordinal,
        content: chunk.content,
        embedding: vectors[index] ?? [],
        terms: termFrequencies(chunk.content),
        tokens: chunk.tokens,
        headings: chunk.headings,
      })),
    });

    await prisma.knowledgeDocument.update({
      where: { id: document.id },
      data: { status: 'INDEXED' },
    });
  } catch (error) {
    await prisma.knowledgeDocument.update({
      where: { id: document.id },
      data: {
        status: 'FAILED',
        error: error instanceof Error ? error.message.slice(0, 400) : 'Indexing failed.',
      },
    });
    throw error;
  }

  logger().info({ documentId: document.id, chunks: chunks.length }, 'document indexed');
  return { documentId: document.id, chunks: chunks.length, sanitisedPatterns: removed, warnings };
}

export interface RetrieveOptions {
  limit?: number;
  /** Minimum blended score. Below this a passage is noise, not context. */
  minScore?: number;
  projectId?: string | null;
}

/**
 * Retrieves passages relevant to a query, scoped to what this user may see.
 *
 * The returned snippets are already delimited, so the caller can drop them
 * straight into a prompt without re-deriving the untrusted-content wrapper.
 */
export async function retrieveKnowledge(
  user: SessionUser | null,
  query: string,
  options: RetrieveOptions = {},
): Promise<Citation[]> {
  const limit = options.limit ?? 4;
  const minScore = options.minScore ?? 0.12;
  if (query.trim().length < 4) return [];

  const documents = await prisma.knowledgeDocument.findMany({
    where: {
      status: 'INDEXED',
      OR: [
        { scope: 'LIBRARY' },
        ...(user ? [{ scope: 'USER' as const, ownerId: user.id }] : []),
        ...(user && options.projectId
          ? [{ scope: 'PROJECT' as const, ownerId: user.id, projectId: options.projectId }]
          : []),
      ],
    },
    select: { id: true, title: true, source: true },
    take: 200,
  });
  if (documents.length === 0) return [];

  const documentById = new Map(documents.map((document) => [document.id, document]));

  const chunks = await prisma.knowledgeChunk.findMany({
    where: { documentId: { in: documents.map((document) => document.id) } },
    select: {
      id: true,
      documentId: true,
      content: true,
      embedding: true,
      terms: true,
      headings: true,
    },
    take: 5_000,
  });
  if (chunks.length === 0) return [];

  const embedder = createEmbeddingProvider();
  const [queryVector] = await embedder.embed([query]);
  const queryTerms = new Set(tokenize(query));

  const scored = chunks.map((chunk) => {
    const embedding = Array.isArray(chunk.embedding) ? (chunk.embedding as number[]) : [];
    const dense = queryVector ? cosineSimilarity(queryVector, embedding) : 0;

    const terms = (chunk.terms ?? {}) as Record<string, number>;
    let overlap = 0;
    for (const term of queryTerms) {
      if (terms[term]) overlap += 1;
    }
    const lexical = queryTerms.size > 0 ? overlap / queryTerms.size : 0;

    // Weighted towards lexical because the default embedder is lexical too;
    // a neural embedder would justify shifting this the other way.
    return { chunk, score: dense * 0.45 + lexical * 0.55 };
  });

  return scored
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => {
      const document = documentById.get(entry.chunk.documentId);
      const heading = entry.chunk.headings ? `${entry.chunk.headings}\n\n` : '';
      return {
        documentId: entry.chunk.documentId,
        title: document?.title ?? 'Reference document',
        source: document?.source ?? '',
        snippet: delimitPassage(
          document?.title ?? 'Reference document',
          `${heading}${entry.chunk.content}`.slice(0, 1_400),
        ),
        score: Number(entry.score.toFixed(4)),
      } satisfies Citation;
    });
}

export interface DocumentSummary {
  id: string;
  title: string;
  source: string;
  licence: string;
  scope: string;
  status: string;
  sizeBytes: number;
  chunkCount: number;
  createdAt: string;
  error: string | null;
}

export async function listDocuments(
  user: SessionUser,
  projectId?: string | null,
): Promise<DocumentSummary[]> {
  const rows = await prisma.knowledgeDocument.findMany({
    where: {
      OR: [
        { scope: 'LIBRARY' },
        { ownerId: user.id, ...(projectId ? {} : { scope: 'USER' }) },
        ...(projectId ? [{ ownerId: user.id, projectId }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { _count: { select: { chunks: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    source: row.source,
    licence: row.licence,
    scope: row.scope,
    status: row.status,
    sizeBytes: row.sizeBytes,
    chunkCount: row._count.chunks,
    createdAt: row.createdAt.toISOString(),
    error: row.error,
  }));
}

/**
 * Deletes a document the user owns, and its chunks with it.
 * Library documents are not deletable through this path — they belong to the
 * deployment, not to a user.
 */
export async function deleteDocument(user: SessionUser, documentId: string): Promise<void> {
  const result = await prisma.knowledgeDocument.deleteMany({
    where: { id: documentId, ownerId: user.id, scope: { in: ['USER', 'PROJECT'] } },
  });
  if (result.count === 0) {
    throw new Error('That document does not exist, or it is part of the shared library.');
  }
}
