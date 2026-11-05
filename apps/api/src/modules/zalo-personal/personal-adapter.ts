// Business/session services depend on this port, never on the unofficial client.
export type QrEvent =
  | { type: 'generated'; image: string; expiresAt: Date }
  | { type: 'scanned'; name?: string }
  | { type: 'expired' }
  | { type: 'declined' };
export type PersonalLogin = {
  externalAccountId: string;
  credentials: string;
  name?: string;
  avatarUrl?: string;
};
export type PersonalProfile = {
  externalUserId: string;
  name?: string;
  avatarUrl?: string;
};
export type PersonalSticker = { stickerId: number; url: string };
export interface PersonalAdapter {
  connectWithQR(onEvent: (event: QrEvent) => void): Promise<PersonalLogin>;
  restoreSession(credentials: string): Promise<PersonalLogin>;
  disconnect(): void;
  getConnectionStatus(): 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';
  startListening(
    onMessage: (message: unknown) => void,
    onClosed: (code: string) => void,
  ): Promise<void>;
  stopListening(): void;
  getUserProfiles(userIds: string[]): Promise<PersonalProfile[]>;
  getStickerAssets(stickerIds: number[]): Promise<PersonalSticker[]>;
  getRecentMessages(): Promise<unknown[]>;
  sendTextMessage(
    threadId: string,
    content: string,
  ): Promise<{ externalMessageId: string }>;
}
export const PERSONAL_ADAPTER_FACTORY = Symbol('PERSONAL_ADAPTER_FACTORY');
export type PersonalAdapterFactory = () => PersonalAdapter;
export class PersonalAdapterError extends Error {
  constructor(
    readonly code: string,
    readonly safeToRetry = false,
  ) {
    super(code);
  }
}
