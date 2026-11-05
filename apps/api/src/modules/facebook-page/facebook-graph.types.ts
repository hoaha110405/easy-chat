/** Provider-neutral DTOs. Access tokens in these types are backend-only secrets. */
export interface FacebookGraphConfig {
  appId: string;
  appSecret: string;
  graphVersion: string;
  timeoutMs?: number;
}

export interface FacebookCursorInput {
  after?: string | null;
  limit?: number;
}

export interface FacebookCursorPage<T> {
  items: T[];
  after: string | null;
}

export interface FacebookToken {
  accessToken: string;
  expiresIn: number | null;
  tokenType: string | null;
}

export interface FacebookPermission {
  permission: string;
  status: string;
}

export interface FacebookPageProfile {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface FacebookPageSummary extends FacebookPageProfile {
  accessToken: string;
  tasks: string[];
}

export interface FacebookParticipant {
  id: string;
  name?: string;
}

export interface FacebookConversation {
  id: string;
  updatedAt: string;
  participants: FacebookParticipant[];
  messageCount?: number;
  snippet?: string;
}

export interface FacebookAttachment {
  type: string;
  url: string | null;
  previewUrl: string | null;
  name: string | null;
}

export interface FacebookMessage {
  id: string;
  createdAt: string;
  from: FacebookParticipant;
  to: FacebookParticipant[];
  text: string;
  attachments: FacebookAttachment[];
}

export interface FacebookSendResult {
  messageId: string;
  recipientId: string;
}

export interface FacebookUserProfile {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface FacebookTokenInspection {
  appId: string;
  valid: boolean;
  type: string | null;
  userId: string | null;
  profileId: string | null;
  expiresAt: number | null;
  dataAccessExpiresAt: number | null;
  scopes: string[];
  granularScopes: { scope: string; targetIds: string[] }[];
}
