-- CreateEnum
CREATE TYPE "PersonalConnectionStatus" AS ENUM ('DISCONNECTED', 'QR_PENDING', 'CONNECTING', 'CONNECTED', 'RECONNECTING', 'REAUTH_REQUIRED', 'ERROR');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PersonalCommandKind" AS ENUM ('LOGIN_QR', 'SEND');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- AlterEnum
ALTER TYPE "MessageSource" ADD VALUE 'PERSONAL';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "channelAccountId" TEXT,
ADD COLUMN     "externalThreadType" TEXT NOT NULL DEFAULT 'USER',
ALTER COLUMN "connectionId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "channelAccountId" TEXT,
ADD COLUMN     "deliveryError" TEXT,
ADD COLUMN     "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'SENT',
ADD COLUMN     "externalSenderId" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "sendAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sendingAt" TIMESTAMP(3),
ALTER COLUMN "connectionId" DROP NOT NULL,
ALTER COLUMN "externalMessageId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "channelAccountId" TEXT;

-- CreateTable
CREATE TABLE "ChannelAccount" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "channelType" TEXT NOT NULL DEFAULT 'ZALO_PERSONAL',
    "name" TEXT NOT NULL DEFAULT 'Zalo Personal',
    "externalAccountId" TEXT,
    "connectionStatus" "PersonalConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "encryptedCredentials" TEXT,
    "encryptedQr" TEXT,
    "qrStatus" TEXT NOT NULL DEFAULT 'NONE',
    "qrExpiresAt" TIMESTAMP(3),
    "generation" INTEGER NOT NULL DEFAULT 0,
    "lastConnectedAt" TIMESTAMP(3),
    "lastSendAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalCommand" (
    "id" TEXT NOT NULL,
    "channelAccountId" TEXT NOT NULL,
    "messageId" TEXT,
    "kind" "PersonalCommandKind" NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'PENDING',
    "generation" INTEGER NOT NULL,
    "deduplicationKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalWorkerState" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalWorkerState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAccount_externalAccountId_key" ON "ChannelAccount"("externalAccountId");

-- CreateIndex
CREATE INDEX "ChannelAccount_ownerId_createdAt_idx" ON "ChannelAccount"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalCommand_messageId_key" ON "PersonalCommand"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalCommand_deduplicationKey_key" ON "PersonalCommand"("deduplicationKey");

-- CreateIndex
CREATE INDEX "PersonalCommand_status_availableAt_createdAt_idx" ON "PersonalCommand"("status", "availableAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_channelAccountId_externalUserId_externalThread_key" ON "Conversation"("channelAccountId", "externalUserId", "externalThreadType");

-- CreateIndex
CREATE UNIQUE INDEX "Message_channelAccountId_externalMessageId_key" ON "Message"("channelAccountId", "externalMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_channelAccountId_idempotencyKey_key" ON "Message"("channelAccountId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalCommand" ADD CONSTRAINT "PersonalCommand_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalCommand" ADD CONSTRAINT "PersonalCommand_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve OA records while enforcing one channel per conversation/message.
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_exactly_one_channel" CHECK (("connectionId" IS NOT NULL)::int + ("channelAccountId" IS NOT NULL)::int = 1);
ALTER TABLE "Message" ADD CONSTRAINT "Message_exactly_one_channel" CHECK (("connectionId" IS NOT NULL)::int + ("channelAccountId" IS NOT NULL)::int = 1);
