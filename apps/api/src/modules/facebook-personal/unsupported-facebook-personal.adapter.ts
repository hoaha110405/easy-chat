import {
  FACEBOOK_PERSONAL_CAPABILITIES,
  FacebookPersonalAdapterError,
  type FacebookPersonalAdapter,
  type FacebookPersonalConnectionState,
  type FacebookPersonalConversation,
  type FacebookPersonalIdentity,
  type FacebookPersonalMessage,
  type FacebookPersonalPage,
  type FacebookPersonalSession,
} from './facebook-personal.adapter';

// Deliberate fail-closed implementation, not a simulated Messenger client.
// There is no network client, credential persistence, timer or registered listener.
export class UnsupportedFacebookPersonalAdapter implements FacebookPersonalAdapter {
  readonly capabilities = FACEBOOK_PERSONAL_CAPABILITIES;
  private state: FacebookPersonalConnectionState = 'UNSUPPORTED';

  async connect(
    _session: FacebookPersonalSession,
  ): Promise<FacebookPersonalIdentity> {
    this.state = 'UNSUPPORTED';
    throw new FacebookPersonalAdapterError('connect');
  }

  async restoreSession(
    _session: FacebookPersonalSession,
  ): Promise<FacebookPersonalIdentity> {
    this.state = 'UNSUPPORTED';
    throw new FacebookPersonalAdapterError('restoreSession');
  }

  disconnect() {
    this.state = 'DISCONNECTED';
  }

  getConnectionStatus() {
    return this.state;
  }

  async listConversations(
    _cursor?: string,
  ): Promise<FacebookPersonalPage<FacebookPersonalConversation>> {
    throw new FacebookPersonalAdapterError('listConversations');
  }

  async getMessages(
    _externalThreadId: string,
    _cursor?: string,
  ): Promise<FacebookPersonalPage<FacebookPersonalMessage>> {
    throw new FacebookPersonalAdapterError('history');
  }

  async startListening(
    _onMessage: (message: FacebookPersonalMessage) => void,
    _onClosed: (state: 'REAUTH_REQUIRED' | 'ERROR') => void,
  ): Promise<void> {
    throw new FacebookPersonalAdapterError('receive');
  }

  stopListening(): void {
    // No listener exists. Cleanup remains idempotent for worker shutdown.
  }

  async sendTextMessage(
    _externalThreadId: string,
    _content: string,
  ): Promise<{ externalMessageId: string }> {
    throw new FacebookPersonalAdapterError('sendText');
  }
}
