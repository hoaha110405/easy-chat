CREATE TABLE "MessageMedia" (
 "id" TEXT NOT NULL, "messageId" TEXT NOT NULL, "name" TEXT NOT NULL, "mime" TEXT NOT NULL,
 "size" INTEGER NOT NULL, "sha256" TEXT NOT NULL, "encryptedBytes" BYTEA NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MessageMedia_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "MessageMedia_size_check" CHECK ("size" > 0 AND "size" <= 20000000)
);
CREATE UNIQUE INDEX "MessageMedia_messageId_key" ON "MessageMedia"("messageId");
CREATE INDEX "MessageMedia_expiresAt_idx" ON "MessageMedia"("expiresAt");
ALTER TABLE "MessageMedia" ADD CONSTRAINT "MessageMedia_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
