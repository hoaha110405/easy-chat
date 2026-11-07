-- AlterEnum
ALTER TYPE "MessageSource" ADD VALUE 'TIKTOK';

-- AlterEnum
ALTER TYPE "PersonalConnectionStatus" ADD VALUE 'PERMISSION_REQUIRED';

-- AlterTable
ALTER TABLE "ChannelAccount" ADD COLUMN     "capabilities" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "refreshExpiresAt" TIMESTAMP(3),
ADD COLUMN     "tokenExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "externalContactId" TEXT,
ADD COLUMN     "providerState" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "unreadCount" INTEGER;

-- CreateTable
CREATE TABLE "ChannelAuthorization" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "channelType" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "encryptedSelection" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAuthorization_stateHash_key" ON "ChannelAuthorization"("stateHash");

-- CreateIndex
CREATE INDEX "ChannelAuthorization_sessionId_channelType_expiresAt_idx" ON "ChannelAuthorization"("sessionId", "channelType", "expiresAt");

-- AddForeignKey
ALTER TABLE "ChannelAuthorization" ADD CONSTRAINT "ChannelAuthorization_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AdminSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

