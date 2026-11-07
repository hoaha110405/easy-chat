-- Existing messages have no reliable local read state; keep their baseline read.
ALTER TABLE "Message" ADD COLUMN "inboxUnread" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Message_conversationId_inboxUnread_idx" ON "Message"("conversationId", "inboxUnread");
CREATE INDEX "Message_channelAccountId_inboxUnread_idx" ON "Message"("channelAccountId", "inboxUnread");
CREATE INDEX "Message_connectionId_inboxUnread_idx" ON "Message"("connectionId", "inboxUnread");
