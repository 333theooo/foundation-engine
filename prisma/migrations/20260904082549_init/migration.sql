-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "VersionKind" AS ENUM ('AUTOSAVE', 'MANUAL', 'SNAPSHOT', 'IMPORT', 'RESTORE_POINT');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('APPLIED', 'ROLLED_BACK', 'REJECTED', 'CLARIFICATION');

-- CreateEnum
CREATE TYPE "DocumentScope" AS ENUM ('LIBRARY', 'USER', 'PROJECT');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'INDEXED', 'FAILED');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('IMPORT_SOURCE', 'TEXTURE', 'THUMBNAIL', 'EXPORT', 'DOCUMENT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "isGuest" BOOLEAN NOT NULL DEFAULT false,
    "guestExpires" TIMESTAMP(3),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ipHash" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "model" JSONB NOT NULL,
    "elementCount" INTEGER NOT NULL DEFAULT 0,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "VersionKind" NOT NULL DEFAULT 'AUTOSAVE',
    "model" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Design conversation',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "messageId" TEXT,
    "transactionId" TEXT NOT NULL,
    "status" "OperationStatus" NOT NULL,
    "request" TEXT NOT NULL,
    "sceneSummary" JSONB NOT NULL,
    "commands" JSONB NOT NULL,
    "inverse" JSONB NOT NULL,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "model" TEXT NOT NULL DEFAULT '',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationFeedback" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "projectId" TEXT,
    "scope" "DocumentScope" NOT NULL DEFAULT 'USER',
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "licence" TEXT NOT NULL DEFAULT '',
    "mimeType" TEXT NOT NULL DEFAULT 'text/plain',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "terms" JSONB NOT NULL DEFAULT '{}',
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "headings" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "projectId" TEXT,
    "kind" "AssetKind" NOT NULL DEFAULT 'IMPORT_SOURCE',
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitHit" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_isGuest_guestExpires_idx" ON "User"("isGuest", "guestExpires");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Project_ownerId_updatedAt_idx" ON "Project"("ownerId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Project_ownerId_archivedAt_idx" ON "Project"("ownerId", "archivedAt");

-- CreateIndex
CREATE INDEX "ProjectVersion_projectId_createdAt_idx" ON "ProjectVersion"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ProjectVersion_projectId_kind_idx" ON "ProjectVersion"("projectId", "kind");

-- CreateIndex
CREATE INDEX "Conversation_projectId_createdAt_idx" ON "Conversation"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Operation_projectId_createdAt_idx" ON "Operation"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Operation_status_idx" ON "Operation"("status");

-- CreateIndex
CREATE INDEX "OperationFeedback_rating_idx" ON "OperationFeedback"("rating");

-- CreateIndex
CREATE UNIQUE INDEX "OperationFeedback_operationId_userId_key" ON "OperationFeedback"("operationId", "userId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_ownerId_scope_idx" ON "KnowledgeDocument"("ownerId", "scope");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_projectId_idx" ON "KnowledgeDocument"("projectId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_scope_status_idx" ON "KnowledgeDocument"("scope", "status");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_documentId_idx" ON "KnowledgeChunk"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_documentId_ordinal_key" ON "KnowledgeChunk"("documentId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_key_key" ON "Asset"("key");

-- CreateIndex
CREATE INDEX "Asset_ownerId_createdAt_idx" ON "Asset"("ownerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Asset_projectId_idx" ON "Asset"("projectId");

-- CreateIndex
CREATE INDEX "RateLimitHit_bucket_createdAt_idx" ON "RateLimitHit"("bucket", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectVersion" ADD CONSTRAINT "ProjectVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationFeedback" ADD CONSTRAINT "OperationFeedback_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationFeedback" ADD CONSTRAINT "OperationFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
