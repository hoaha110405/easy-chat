-- AlterEnum
ALTER TYPE "MessageSource" ADD VALUE 'FACEBOOK';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PersonalCommandKind" ADD VALUE 'SYNC';
ALTER TYPE "PersonalCommandKind" ADD VALUE 'SYNC_MESSAGES';

-- AlterEnum
ALTER TYPE "PersonalConnectionStatus" ADD VALUE 'UNSUPPORTED';

-- DropIndex
DROP INDEX "ChannelAccount_externalAccountId_key";

-- AlterTable
ALTER TABLE "AdminSession" ADD COLUMN     "encryptedFacebookSelection" TEXT,
ADD COLUMN     "facebookSelectionExpiresAt" TIMESTAMP(3),
ADD COLUMN     "facebookStateExpiresAt" TIMESTAMP(3),
ADD COLUMN     "facebookStateHash" TEXT;

-- AlterTable
ALTER TABLE "ChannelAccount" ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncError" TEXT,
ADD COLUMN     "syncComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "syncCursor" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "externalConversationId" TEXT,
ADD COLUMN     "lastInboundAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "syncComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "syncCursor" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "readAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PersonalCommand" ADD COLUMN     "payload" JSONB NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE INDEX "ChannelAccount_channelType_externalAccountId_idx" ON "ChannelAccount"("channelType", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAccount_ownerId_channelType_externalAccountId_key" ON "ChannelAccount"("ownerId", "channelType", "externalAccountId");

-- CreateIndex
CREATE INDEX "Conversation_channelAccountId_externalConversationId_idx" ON "Conversation"("channelAccountId", "externalConversationId");

-- CreateIndex
CREATE INDEX "Message_channelAccountId_deliveryStatus_idx" ON "Message"("channelAccountId", "deliveryStatus");

-- CreateIndex
CREATE INDEX "PersonalCommand_channelAccountId_status_idx" ON "PersonalCommand"("channelAccountId", "status");

