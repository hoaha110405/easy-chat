// Provider SDK types stay in infrastructure adapters. Authentication capabilities are separate.
export interface MessageSender {
  sendText(
    accountId: string,
    threadId: string,
    text: string,
  ): Promise<{ externalMessageId: string }>;
}
export interface OAuthConnectable {
  connect(sessionId: string): Promise<string>;
}
export interface ConversationSyncable {
  queueSync(accountId: string, ownerId: string): Promise<{ queued: boolean }>;
}
export interface SessionConnectable {
  restoreSession(credentials: string): Promise<void>;
  disconnect(): void;
}
export interface MessageListener {
  startListening(
    onMessage: (message: unknown) => void,
    onClosed: (reason: string) => void,
  ): Promise<void>;
  stopListening(): void;
}
