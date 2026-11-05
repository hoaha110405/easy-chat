// Application ports only. No unofficial SDK or session material reaches HTTP DTOs.
export type FacebookPersonalConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'REAUTH_REQUIRED'
  | 'UNSUPPORTED'
  | 'ERROR';

export type FacebookPersonalOperation =
  | 'connect'
  | 'restoreSession'
  | 'listConversations'
  | 'history'
  | 'receive'
  | 'sendText'
  | 'e2ee';

export type FacebookPersonalCapabilities = Readonly<{
  connect: boolean;
  listConversations: boolean;
  history: boolean;
  receive: boolean;
  sendText: boolean;
  e2ee: boolean;
}>;

export const FACEBOOK_PERSONAL_CAPABILITIES: FacebookPersonalCapabilities =
  Object.freeze({
    connect: false,
    listConversations: false,
    history: false,
    receive: false,
    sendText: false,
    e2ee: false,
  });

export const FACEBOOK_PERSONAL_UNSUPPORTED_MESSAGE =
  'Chưa có thư viện Messenger cá nhân được kiểm chứng cho phiên bản hiện tại. Kết nối, đồng bộ, nhận và gửi tin nhắn đang không được hỗ trợ; bao gồm hội thoại mã hóa đầu cuối (E2EE).';

export type FacebookPersonalSession = {
  // Future reviewed worker adapters must verify the authenticated identity matches.
  expectedExternalAccountId: string;
  opaqueSession: string;
};

export type FacebookPersonalIdentity = { externalAccountId: string };
export type FacebookPersonalConversation = {
  externalThreadId: string;
  externalThreadType: 'USER' | 'GROUP';
  encryption: 'PLAIN' | 'E2EE' | 'UNKNOWN';
};
export type FacebookPersonalMessage = {
  externalMessageId: string;
  externalThreadId: string;
  externalSenderId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  content: string;
  sentAt: Date;
};
export type FacebookPersonalPage<T> = {
  data: T[];
  cursor: string | null;
  complete: boolean;
};

// Session provisioning belongs exclusively to a reviewed worker implementation.
// This contract does not provide a public cookie/password import endpoint.
export interface FacebookPersonalSessionConnectable {
  connect(session: FacebookPersonalSession): Promise<FacebookPersonalIdentity>;
  restoreSession(
    session: FacebookPersonalSession,
  ): Promise<FacebookPersonalIdentity>;
  disconnect(): void;
  getConnectionStatus(): FacebookPersonalConnectionState;
}

export interface FacebookPersonalConversationSyncable {
  listConversations(
    cursor?: string,
  ): Promise<FacebookPersonalPage<FacebookPersonalConversation>>;
  getMessages(
    externalThreadId: string,
    cursor?: string,
  ): Promise<FacebookPersonalPage<FacebookPersonalMessage>>;
}

export interface FacebookPersonalMessageListener {
  startListening(
    onMessage: (message: FacebookPersonalMessage) => void,
    onClosed: (state: 'REAUTH_REQUIRED' | 'ERROR') => void,
  ): Promise<void>;
  stopListening(): void;
}

export interface FacebookPersonalMessageSender {
  sendTextMessage(
    externalThreadId: string,
    content: string,
  ): Promise<{ externalMessageId: string }>;
}

export interface FacebookPersonalAdapter
  extends
    FacebookPersonalSessionConnectable,
    FacebookPersonalConversationSyncable,
    FacebookPersonalMessageListener,
    FacebookPersonalMessageSender {
  readonly capabilities: FacebookPersonalCapabilities;
}

export class FacebookPersonalAdapterError extends Error {
  readonly safeToRetry = false;

  constructor(readonly operation: FacebookPersonalOperation) {
    super(FACEBOOK_PERSONAL_UNSUPPORTED_MESSAGE);
    this.name = 'FacebookPersonalAdapterError';
  }

  get code() {
    return this.operation === 'e2ee'
      ? 'FACEBOOK_PERSONAL_E2EE_UNSUPPORTED'
      : 'FACEBOOK_PERSONAL_UNSUPPORTED';
  }
}
