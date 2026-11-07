import { Inject, Injectable } from '@nestjs/common';
import {
  mkdir,
  chmod,
  lstat,
  rm,
  writeFile,
  readFile,
  realpath,
  stat,
  readdir,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { z } from 'zod';
import type { ChannelAccount } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService, hash } from '../../common/crypto.service';
import { publishEvent } from '../realtime/publish';
import { TelegramSettings } from '../telegram/telegram.config';
import {
  TelegramError,
  personalCredentialsSchema,
  telegramId,
  telegramJson,
  tdNumber,
  tdError,
} from '../telegram/telegram.types';
import { TelegramReceipts } from '../telegram/telegram-receipts.service';
import type { TelegramRpcRequest } from '../telegram/telegram.rpc';
import {
  authPresentation,
  authRequest,
  tdChatAllowed,
  tdChatSchema,
  tdMessageSchema,
  validTdVersion,
} from './tdlib.mapper';
import type { TdClient, TdObject } from './tdjson.client';
export const TDLIB_CLIENT_FACTORY = Symbol('TDLIB_CLIENT_FACTORY');
type Entry = {
  account: ChannelAccount;
  client: TdClient;
  state: TdObject;
  chats: Map<string, z.infer<typeof tdChatSchema>>;
  users: Map<string, string>;
  queue: Promise<void>;
  closing: boolean;
  ready: boolean;
  authBusy: boolean;
  networkReady: boolean;
  sending: Map<string, TdObject>;
  listeners: Set<(event: TdObject) => void>;
};
@Injectable()
export class TdLibManager {
  private entries = new Map<string, Entry>();
  private restoring = new Set<string>();
  private failures = new Map<string, { at: number; attempts: number }>();
  private stopping = false;
  constructor(
    private readonly db: PrismaService,
    private readonly crypto: CryptoService,
    private readonly settings: TelegramSettings,
    private readonly receipts: TelegramReceipts,
    @Inject(TDLIB_CLIENT_FACTORY)
    private readonly factory: (bridge: string, library: string) => TdClient,
  ) {}
  private credentials(account: ChannelAccount) {
    try {
      return personalCredentialsSchema.parse(
        JSON.parse(this.crypto.decrypt(account.encryptedCredentials!)),
      );
    } catch {
      throw new TelegramError('TELEGRAM_REAUTH_REQUIRED');
    }
  }
  private async directory(id: string) {
    z.string().cuid().parse(id);
    const root = this.settings.paths().data;
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink())
      throw new TelegramError('TELEGRAM_STORAGE_INVALID');
    await chmod(root, 0o700);
    const directory = join(root, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink())
      throw new TelegramError('TELEGRAM_STORAGE_INVALID');
    return directory;
  }
  async start(account: ChannelAccount) {
    const fresh = await this.db.channelAccount.findUnique({
      where: { id: account.id },
    });
    if (
      !fresh ||
      fresh.generation !== account.generation ||
      ['DISCONNECTED', 'REAUTH_REQUIRED', 'ERROR'].includes(
        fresh.connectionStatus,
      )
    )
      return;
    account = fresh;
    const existing = this.entries.get(account.id);
    if (
      existing?.account.generation === account.generation &&
      !existing.closing
    )
      return;
    if (this.restoring.has(account.id)) return;
    this.restoring.add(account.id);
    try {
      if (
        !this.settings.personalConfigured ||
        !(await this.settings.nativeAvailable())
      )
        throw new TelegramError('TELEGRAM_NATIVE_UNAVAILABLE');
      if (existing) await this.stopAccount(account.id, false);
      const credentials = this.credentials(account);
      if (credentials.apiId !== this.settings.config.env.TELEGRAM_API_ID)
        throw new TelegramError('TELEGRAM_REAUTH_REQUIRED');
      const directory = await this.directory(account.id);
      await chmod(directory, 0o700);
      const paths = this.settings.paths();
      const client = this.factory(paths.bridge, paths.library);
      const entry: Entry = {
        account,
        client,
        state: { '@type': 'authorizationStateWaitTdlibParameters' },
        chats: new Map(),
        users: new Map(),
        queue: Promise.resolve(),
        closing: false,
        ready: false,
        authBusy: false,
        networkReady: false,
        sending: new Map(),
        listeners: new Set(),
      };
      this.entries.set(account.id, entry);
      client.on('closed', () => {
        if (!entry.closing && !this.stopping)
          void this.lost(entry).catch(() => undefined);
      });
      client.on('update', (event) => {
        if (entry.closing || this.stopping) return;
        entry.queue = entry.queue
          .then(() => this.update(entry, event))
          .catch(() => this.lost(entry).catch(() => undefined));
      });
      const version = await client.request({
        '@type': 'getOption',
        name: 'version',
      });
      if (!validTdVersion(version))
        throw new TelegramError('TELEGRAM_TDLIB_VERSION_UNSUPPORTED');
      // Constructor may already have emitted the state. Ask TDLib, never assume auth success.
      const state = await client.request({ '@type': 'getAuthorizationState' });
      await this.authorization(entry, state);
    } catch (error) {
      await this.stopAccount(account.id, false);
      throw error;
    } finally {
      this.restoring.delete(account.id);
    }
  }
  private async current(entry: Entry) {
    const account = await this.db.channelAccount.findUnique({
      where: { id: entry.account.id },
    });
    return account?.generation === entry.account.generation &&
      account.connectionStatus !== 'DISCONNECTED'
      ? account
      : null;
  }
  private async authorization(entry: Entry, state: TdObject) {
    if (entry.closing || this.stopping || !(await this.current(entry))) return;
    if (
      entry.state['@type'] === state['@type'] &&
      state['@type'] === 'authorizationStateWaitTdlibParameters' &&
      entry.authBusy
    )
      return;
    entry.state = state;
    if (state['@type'] === 'authorizationStateWaitTdlibParameters') {
      const c = this.credentials(entry.account);
      const directory = join(this.settings.paths().data, entry.account.id);
      entry.authBusy = true;
      try {
        await entry.client.request(
          {
            '@type': 'setTdlibParameters',
            use_test_dc: false,
            database_directory: join(directory, 'database'),
            files_directory: join(directory, 'files'),
            database_encryption_key: c.databaseKey,
            use_file_database: true,
            use_chat_info_database: true,
            use_message_database: true,
            use_secret_chats: false,
            api_id: c.apiId,
            api_hash: this.settings.config.env.TELEGRAM_API_HASH,
            system_language_code: 'vi',
            device_model: 'easyChat',
            system_version: 'Linux',
            application_version: '0.1.0',
          },
          'auth',
        );
      } finally {
        entry.authBusy = false;
      }
      return;
    }
    if (state['@type'] === 'authorizationStateReady') {
      const credentials = this.credentials(entry.account);
      if (credentials.loginSessionId) {
        const session = await this.db.adminSession.findFirst({
          where: {
            id: credentials.loginSessionId,
            expiresAt: { gt: new Date() },
          },
        });
        if (!session || (credentials.loginExpiresAt ?? 0) < Date.now()) {
          await this.stopAccount(entry.account.id, true);
          await this.db.channelAccount.updateMany({
            where: {
              id: entry.account.id,
              generation: entry.account.generation,
            },
            data: {
              connectionStatus: 'DISCONNECTED',
              encryptedCredentials: null,
              capabilities: {},
            },
          });
          return;
        }
      }
      const me = z
        .object({
          id: telegramId,
          first_name: z.string(),
          last_name: z.string().optional(),
        })
        .parse(await entry.client.request({ '@type': 'getMe' }));
      if (
        entry.account.externalAccountId &&
        me.id !== entry.account.externalAccountId
      ) {
        await this.stopAccount(entry.account.id, true);
        await this.db.channelAccount.updateMany({
          where: { id: entry.account.id, generation: entry.account.generation },
          data: {
            connectionStatus: 'REAUTH_REQUIRED',
            encryptedCredentials: null,
            capabilities: {},
            lastError: 'TELEGRAM_ACCOUNT_MISMATCH',
          },
        });
        return;
      }
      const account = await this.db.$transaction(async (tx) => {
        const current = (
          await tx.$queryRaw<
            ChannelAccount[]
          >`SELECT * FROM "ChannelAccount" WHERE "id"=${entry.account.id} AND "generation"=${entry.account.generation} FOR UPDATE`
        )[0];
        if (!current || current.connectionStatus === 'DISCONNECTED')
          return null;
        const linked = await tx.channelAccount.update({
          where: { id: current.id },
          data: {
            externalAccountId: me.id,
            name: [me.first_name, me.last_name].filter(Boolean).join(' '),
            connectionStatus: 'CONNECTED',
            encryptedCredentials: this.crypto.encrypt(
              JSON.stringify({
                databaseKey: credentials.databaseKey,
                apiId: credentials.apiId,
              }),
            ),
            capabilities: {
              receiveMessages: true,
              sendMessages: true,
              syncConversations: true,
              readReceipts: true,
            },
            lastConnectedAt: new Date(),
            lastError: null,
          },
        });
        const pending = await tx.personalCommand.findFirst({
          where: {
            channelAccountId: linked.id,
            generation: linked.generation,
            kind: 'SYNC',
            status: { in: ['PENDING', 'PROCESSING'] },
          },
        });
        if (!pending)
          await tx.personalCommand.create({
            data: {
              channelAccountId: linked.id,
              generation: linked.generation,
              kind: 'SYNC',
              deduplicationKey: `telegram:restore:${linked.id}:${linked.generation}:${Date.now()}`,
              payload: { list: 'main', page: 0 },
            },
          });
        await publishEvent(tx, linked.ownerId, {
          type: 'channel.connected',
          channelAccountId: linked.id,
        });
        return linked;
      });
      if (account) {
        entry.account = account;
        entry.ready = true;
        this.failures.delete(account.id);
      }
      return;
    }
    if (state['@type'] === 'authorizationStateClosed') {
      if (!entry.closing) await this.lost(entry);
      return;
    }
    if (
      state['@type'] === 'authorizationStateWaitPhoneNumber' &&
      entry.account.connectionStatus === 'CONNECTED'
    ) {
      entry.ready = false;
      await this.db.channelAccount.updateMany({
        where: { id: entry.account.id, generation: entry.account.generation },
        data: {
          connectionStatus: 'REAUTH_REQUIRED',
          capabilities: {},
          lastError: 'TELEGRAM_REAUTH_REQUIRED',
        },
      });
    }
  }
  private async update(entry: Entry, event: TdObject) {
    if (entry.closing || this.stopping) return;
    if (event['@type'] === 'updateAuthorizationState')
      return this.authorization(entry, event.authorization_state as TdObject);
    if (event['@type'] === 'updateUser') {
      const user = z
        .object({
          id: telegramId,
          first_name: z.string(),
          last_name: z.string().optional(),
        })
        .safeParse(event.user);
      if (user.success)
        entry.users.set(
          user.data.id,
          [user.data.first_name, user.data.last_name].filter(Boolean).join(' '),
        );
      return;
    }
    if (event['@type'] === 'updateConnectionState') {
      entry.networkReady =
        (event.state as TdObject)?.['@type'] === 'connectionStateReady';
      if (entry.ready)
        await this.db.channelAccount.updateMany({
          where: {
            id: entry.account.id,
            generation: entry.account.generation,
            connectionStatus: { in: ['CONNECTED', 'RECONNECTING'] },
          },
          data: {
            connectionStatus: entry.networkReady ? 'CONNECTED' : 'RECONNECTING',
            lastError: entry.networkReady
              ? null
              : 'TELEGRAM_NETWORK_RECONNECTING',
          },
        });
      return;
    }
    if (!entry.ready || !(await this.current(entry))) return;
    if (['updateBasicGroup', 'updateSupergroup'].includes(event['@type'])) {
      const basic = event['@type'] === 'updateBasicGroup';
      const group = z
        .object({ id: telegramId })
        .parse(event[basic ? 'basic_group' : 'supergroup']);
      for (const chat of entry.chats.values()) {
        const id = chat.type[basic ? 'basic_group_id' : 'supergroup_id'];
        if (id === undefined || telegramId.parse(id) !== group.id) continue;
        const updated = await this.permissions(entry, chat);
        entry.chats.set(chat.id, updated);
        await this.receipts.accept(
          entry.account,
          { kind: 'chat', data: updated },
          'chat:' + hash(telegramJson.stringify(updated)),
        );
      }
      return;
    }
    if (event['@type'] === 'updateNewChat') {
      const chat = await this.permissions(entry, event.chat);
      entry.chats.set(chat.id, chat);
      if (tdChatAllowed(chat))
        await this.receipts.accept(
          entry.account,
          { kind: 'chat', data: chat },
          'chat:' + hash(telegramJson.stringify(chat)),
        );
      return;
    }
    let chatId: string | undefined;
    if (event.chat_id !== undefined) chatId = telegramId.parse(event.chat_id);
    else if (event.message)
      chatId = tdMessageSchema.parse(event.message).chat_id;
    if (!chatId) return;
    let chat = entry.chats.get(chatId);
    if (!chat) {
      chat = tdChatSchema.parse(
        await entry.client.request({
          '@type': 'getChat',
          chat_id: tdNumber(chatId),
        }),
      );
      entry.chats.set(chatId, chat);
    }
    if (!tdChatAllowed(chat)) return; // No Secret Chats or broadcast channels.
    const type = event['@type'];
    if (type === 'updateNewMessage') {
      const m = tdMessageSchema.parse(event.message);
      if (m.sending_state) return;
      await this.receipts.accept(
        entry.account,
        {
          kind: 'message',
          data: {
            message: m,
            chatType: chat.type['@type'],
            title: chat.title,
            senderName: entry.users.get(m.sender_id.user_id ?? ''),
          },
        },
        `message:${chatId}:${m.id}`,
      );
    } else if (
      type === 'updateMessageSendSucceeded' ||
      type === 'updateMessageSendFailed'
    ) {
      const m = tdMessageSchema.parse(event.message);
      const old = telegramId.parse(event.old_message_id);
      entry.sending.set(old, event);
      if (entry.sending.size > 1000)
        entry.sending.delete(entry.sending.keys().next().value!);
      for (const listener of entry.listeners) listener(event);
      await this.receipts.accept(
        entry.account,
        {
          kind:
            type === 'updateMessageSendSucceeded'
              ? 'send_succeeded'
              : 'send_failed',
          data: { message: m, oldMessageId: old },
        },
        `${type}:${chatId}:${old}:${m.id}`,
      );
    } else if (
      type === 'updateMessageContent' ||
      type === 'updateMessageEdited'
    ) {
      await this.receipts.accept(
        entry.account,
        {
          kind: 'edit',
          data: { chatId, messageId: telegramId.parse(event.message_id) },
        },
        type + ':' + hash(telegramJson.stringify(event)),
      );
    } else if (type === 'updateDeleteMessages') {
      if (event.is_permanent === true && event.from_cache !== true)
        await this.receipts.accept(
          entry.account,
          {
            kind: 'delete',
            data: {
              chatId,
              messageIds: z
                .array(telegramId)
                .max(10000)
                .parse(event.message_ids),
            },
          },
          type + ':' + hash(telegramJson.stringify(event)),
        );
    } else if (
      type === 'updateChatReadInbox' ||
      type === 'updateChatReadOutbox'
    ) {
      const field =
        type === 'updateChatReadInbox'
          ? 'last_read_inbox_message_id'
          : 'last_read_outbox_message_id';
      await this.receipts.accept(
        entry.account,
        {
          kind: type === 'updateChatReadInbox' ? 'read_inbox' : 'read_outbox',
          data: {
            chatId,
            watermark: telegramId.parse(event[field]),
            ...(type === 'updateChatReadInbox'
              ? {
                  unreadCount: z
                    .number()
                    .int()
                    .nonnegative()
                    .parse(event.unread_count),
                }
              : {}),
            privateChat: chat.type['@type'] === 'chatTypePrivate',
          },
        },
        type + ':' + hash(telegramJson.stringify(event)),
      );
    } else if (
      type === 'updateChatPermissions' ||
      type === 'updateChatLastMessage' ||
      type === 'updateChatTitle' ||
      type === 'updateChatPosition'
    ) {
      const current = await this.permissions(
        entry,
        await entry.client.request({
          '@type': 'getChat',
          chat_id: tdNumber(chatId),
        }),
      );
      entry.chats.set(chatId, current);
      await this.receipts.accept(
        entry.account,
        { kind: 'chat', data: current },
        'chat:' + hash(telegramJson.stringify(current)),
      );
    }
  }
  private async lost(entry: Entry) {
    if (entry.closing) return;
    entry.closing = true;
    this.entries.delete(entry.account.id);
    await entry.client.close().catch(() => undefined);
    const previous = this.failures.get(entry.account.id);
    const attempts = (previous?.attempts ?? 0) + 1;
    this.failures.set(entry.account.id, {
      attempts,
      at: Date.now() + Math.min(300000, 2000 * 2 ** Math.min(attempts, 7)),
    });
    await this.db.channelAccount.updateMany({
      where: {
        id: entry.account.id,
        generation: entry.account.generation,
        connectionStatus: { notIn: ['DISCONNECTED', 'REAUTH_REQUIRED'] },
      },
      data: {
        connectionStatus: attempts > 5 ? 'ERROR' : 'RECONNECTING',
        lastError: 'TELEGRAM_NATIVE_UNAVAILABLE',
      },
    });
  }
  async stopAccount(id: string, logout: boolean) {
    const entry = this.entries.get(id);
    let logoutConfirmed = !logout;
    this.entries.delete(id);
    if (entry) {
      entry.closing = true;
      if (logout) {
        try {
          await entry.client.request({ '@type': 'logOut' }, 'auth', 3000);
          logoutConfirmed = true;
        } catch {
          /* Local cleanup still completes; remote logout stays unconfirmed. */
        }
      }
      await entry.client.close();
    }
    if (logout) {
      z.string().cuid().parse(id);
      await rm(join(this.settings.paths().data, id), {
        recursive: true,
        force: true,
      });
    }
    return logoutConfirmed;
  }
  async stop() {
    this.stopping = true;
    const entries = [...this.entries.values()];
    await Promise.allSettled(
      entries.map((entry) => this.stopAccount(entry.account.id, false)),
    );
    // Let durable update transactions finish before Prisma and the worker lease close.
    await Promise.allSettled(entries.map((entry) => entry.queue));
  }
  async poll() {
    for (const id of this.entries.keys()) await this.cleanupOutbound(id);
    if (this.stopping) return;
    const accounts = await this.db.channelAccount.findMany({
      where: { channelType: 'TELEGRAM_PERSONAL' },
      orderBy: { createdAt: 'asc' },
    });
    for (const entry of this.entries.values()) {
      const current = accounts.find((a) => a.id === entry.account.id);
      if (
        !current ||
        current.generation !== entry.account.generation ||
        ['DISCONNECTED', 'REAUTH_REQUIRED', 'ERROR'].includes(
          current.connectionStatus,
        )
      )
        await this.stopAccount(
          entry.account.id,
          current?.connectionStatus === 'DISCONNECTED',
        );
    }
    for (const account of accounts) {
      if (account.connectionStatus === 'DISCONNECTED')
        await this.stopAccount(account.id, true);
      const entry = this.entries.get(account.id);
      if (entry && !entry.ready) {
        const credentials = this.credentials(account);
        const live = credentials.loginSessionId
          ? await this.db.adminSession.findFirst({
              where: {
                id: credentials.loginSessionId,
                expiresAt: { gt: new Date() },
              },
            })
          : null;
        if (!live || (credentials.loginExpiresAt ?? 0) < Date.now()) {
          await this.stopAccount(account.id, true);
          await this.db.channelAccount.updateMany({
            where: { id: account.id, generation: account.generation },
            data: {
              connectionStatus: 'DISCONNECTED',
              encryptedCredentials: null,
              capabilities: {},
              lastError: 'TELEGRAM_AUTH_SESSION_EXPIRED',
            },
          });
        }
      }
    }
    if (!this.settings.personalConfigured) return;
    for (const a of accounts) {
      if (
        a.encryptedCredentials &&
        ['CONNECTED', 'RECONNECTING', 'CONNECTING'].includes(
          a.connectionStatus,
        ) &&
        !this.entries.has(a.id) &&
        (this.failures.get(a.id)?.at ?? 0) <= Date.now()
      ) {
        try {
          await this.start(a);
        } catch {
          const previous = this.failures.get(a.id);
          this.failures.set(a.id, {
            attempts: (previous?.attempts ?? 0) + 1,
            at: Date.now() + 30000,
          });
          await this.db.channelAccount.updateMany({
            where: {
              id: a.id,
              generation: a.generation,
              connectionStatus: { not: 'DISCONNECTED' },
            },
            data: {
              connectionStatus: 'ERROR',
              lastError: 'TELEGRAM_NATIVE_UNAVAILABLE',
            },
          });
        }
      }
    }
  }
  async rpc(request: TelegramRpcRequest): Promise<unknown> {
    if (request.action === 'health')
      return { nativeAvailable: await this.settings.nativeAvailable() };
    const account = await this.db.channelAccount.findFirst({
      where: {
        id: request.accountId,
        ownerId: request.ownerId,
        channelType: 'TELEGRAM_PERSONAL',
      },
    });
    if (!account) throw new TelegramError('TELEGRAM_ACCOUNT_NOT_FOUND');
    if (request.action === 'disconnect') {
      const logoutConfirmed = await this.stopAccount(account.id, true);
      return { closed: true, logoutConfirmed };
    }
    if (request.action === 'start') await this.start(account);
    const entry = this.entries.get(account.id);
    if (
      !entry ||
      entry.account.generation !== account.generation ||
      entry.closing
    )
      throw new TelegramError('TELEGRAM_NATIVE_UNAVAILABLE');
    // Apply updates already received before accepting the next authentication step.
    await entry.queue;
    const credentials = this.credentials(account);
    if (!entry.ready) {
      const session = await this.db.adminSession.findFirst({
        where: { id: request.sessionId, expiresAt: { gt: new Date() } },
      });
      if (
        credentials.loginSessionId !== request.sessionId ||
        !session ||
        (credentials.loginExpiresAt ?? 0) < Date.now()
      )
        throw new TelegramError('TELEGRAM_AUTH_SESSION_EXPIRED');
    }
    if (request.action === 'auth') {
      if (entry.authBusy) throw new TelegramError('TELEGRAM_NATIVE_BUSY');
      if (account.rateLimitedUntil && account.rateLimitedUntil > new Date())
        throw new TelegramError(
          'TELEGRAM_RATE_LIMITED',
          false,
          Math.ceil((account.rateLimitedUntil.getTime() - Date.now()) / 1000),
        );
      const payload = authRequest(
        entry.state['@type'],
        request.authAction ?? '',
        request.value,
      );
      entry.authBusy = true;
      try {
        await entry.client.request(payload, 'auth');
      } catch (error) {
        if (error instanceof TelegramError && error.retryAfter)
          await this.db.channelAccount.update({
            where: { id: account.id },
            data: {
              rateLimitedUntil: new Date(Date.now() + error.retryAfter * 1000),
            },
          });
        throw error;
      } finally {
        entry.authBusy = false;
      }
    }
    return authPresentation(entry.state);
  }
  client(account: ChannelAccount) {
    const entry = this.entries.get(account.id);
    if (
      !entry?.ready ||
      entry.closing ||
      entry.account.generation !== account.generation
    )
      throw new TelegramError('TELEGRAM_NOT_CONNECTED');
    return entry;
  }
  private async permissions(entry: Entry, input: unknown) {
    const chat = tdChatSchema.parse(input);
    let canSend = chat.permissions?.can_send_basic_messages === true;
    let forum = false;
    if (chat.type['@type'] === 'chatTypePrivate') {
      canSend = chat.permissions?.can_send_basic_messages !== false;
    } else if (
      ['chatTypeBasicGroup', 'chatTypeSupergroup'].includes(chat.type['@type'])
    ) {
      const basic = chat.type['@type'] === 'chatTypeBasicGroup';
      const group = await entry.client.request({
        '@type': basic ? 'getBasicGroup' : 'getSupergroup',
        [basic ? 'basic_group_id' : 'supergroup_id']: tdNumber(
          telegramId.parse(
            chat.type[basic ? 'basic_group_id' : 'supergroup_id'],
          ),
        ),
      });
      const status = z
        .object({
          '@type': z.string(),
          is_member: z.boolean().optional(),
          permissions: z
            .object({ can_send_basic_messages: z.boolean() })
            .passthrough()
            .optional(),
        })
        .parse(group.status);
      forum = group.is_forum === true;
      if (
        ['chatMemberStatusCreator', 'chatMemberStatusAdministrator'].includes(
          status['@type'],
        )
      )
        canSend = status.is_member !== false;
      else if (status['@type'] === 'chatMemberStatusRestricted')
        canSend =
          status.is_member === true &&
          status.permissions?.can_send_basic_messages === true;
      else if (status['@type'] !== 'chatMemberStatusMember') canSend = false;
    } else canSend = false;
    return {
      ...chat,
      easychat_can_send: canSend && !forum,
      easychat_topic_unsupported: forum,
    };
  }
  async chats(account: ChannelAccount, list: 'main' | 'archive', load = true) {
    const entry = this.client(account);
    let complete = false;
    try {
      if (load)
        await entry.client.request({
          '@type': 'loadChats',
          chat_list: {
            '@type': list === 'main' ? 'chatListMain' : 'chatListArchive',
          },
          limit: 100,
        });
    } catch (error) {
      if (error instanceof TelegramError && error.code === 'TELEGRAM_NOT_FOUND')
        complete = true;
      else throw error;
    }
    const snapshot = await entry.client.request({
      '@type': 'getChats',
      chat_list: {
        '@type': list === 'main' ? 'chatListMain' : 'chatListArchive',
      },
      limit: 10000,
    });
    const ids = z.array(telegramId).max(10000).parse(snapshot.chat_ids);
    const chats: z.infer<typeof tdChatSchema>[] = [];
    for (const id of ids) {
      let chat = entry.chats.get(id);
      if (!chat) {
        chat = tdChatSchema.parse(
          await entry.client.request({
            '@type': 'getChat',
            chat_id: tdNumber(id),
          }),
        );
        entry.chats.set(id, chat);
      }
      if (tdChatAllowed(chat)) chats.push(await this.permissions(entry, chat));
    }
    return { chats, complete };
  }
  async history(
    account: ChannelAccount,
    chatId: string,
    cursor?: string | null,
  ) {
    const entry = this.client(account);
    const chat = tdChatSchema.parse(
      await entry.client.request({
        '@type': 'getChat',
        chat_id: tdNumber(chatId),
      }),
    );
    if (!tdChatAllowed(chat))
      throw new TelegramError('TELEGRAM_CHAT_UNSUPPORTED');
    const result = await entry.client.request({
      '@type': 'getChatHistory',
      chat_id: tdNumber(chatId),
      from_message_id: tdNumber(cursor ?? '0'),
      offset: 0,
      limit: 25,
      only_local: false,
    });
    const items = z
      .array(tdMessageSchema)
      .max(100)
      .parse(result.messages)
      .filter((m) => !m.sending_state && m.id !== cursor);
    const oldest = items.reduce<string | null>(
      (id, m) => (id === null || BigInt(m.id) < BigInt(id) ? m.id : id),
      null,
    );
    return { items, cursor: items.length === 0 ? null : oldest, chat };
  }
  getMessage(account: ChannelAccount, chatId: string, messageId: string) {
    return this.client(account).client.request({
      '@type': 'getMessage',
      chat_id: tdNumber(chatId),
      message_id: tdNumber(messageId),
    });
  }
  async downloadMedia(account: ChannelAccount, fileId: string) {
    const entry = this.client(account),
      id = z.coerce.number().int().positive().max(2147483647).parse(fileId);
    const info = await entry.client.request({
      '@type': 'getFile',
      file_id: id,
    });
    const size = z.coerce
      .number()
      .int()
      .nonnegative()
      .max(20_000_000)
      .parse(info.size);
    if (size === 0) throw new TelegramError('TELEGRAM_MEDIA_UNAVAILABLE');
    const result = await entry.client.request(
      {
        '@type': 'downloadFile',
        file_id: id,
        priority: 16,
        offset: 0,
        limit: 0,
        synchronous: true,
      },
      'read',
      9000,
    );
    const local = z
      .object({ path: z.string(), is_downloading_completed: z.literal(true) })
      .safeParse(result.local);
    if (!local.success) throw new TelegramError('TELEGRAM_MEDIA_NOT_READY');
    const base = await realpath(
        join(this.settings.paths().data, account.id, 'files'),
      ),
      path = await realpath(local.data.path),
      details = await stat(path);
    if (
      !path.startsWith(base + sep) ||
      !details.isFile() ||
      details.size > 20_000_000 ||
      details.size !== size
    )
      throw new TelegramError('TELEGRAM_MEDIA_UNAVAILABLE');
    const bytes = await readFile(path);
    if (bytes.length !== size)
      throw new TelegramError('TELEGRAM_MEDIA_UNAVAILABLE');
    return bytes;
  }
  async sendMedia(
    account: ChannelAccount,
    chatId: string,
    file: { bytes: Buffer; name: string; mime: string },
    kind: 'document' | 'audio',
    caption: string,
    storeTemporary: (id: string) => Promise<void>,
  ) {
    const directory = await this.directory(account.id),
      parent = join(directory, 'outbound');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if ((await lstat(parent)).isSymbolicLink())
      throw new TelegramError('TELEGRAM_STORAGE_INVALID');
    await chmod(parent, 0o700);
    // Preserve the actual filename in the recipient's document, with an isolated random directory.
    const temporary = join(parent, randomUUID());
    await mkdir(temporary, { mode: 0o700 });
    const name =
      file.name.replace(/[^\p{L}\p{N}_. -]/gu, '_').slice(0, 150) ||
      'telegram-file';
    const path = join(temporary, name);
    await writeFile(path, file.bytes, { mode: 0o600, flag: 'wx' });
    let uncertain = false;
    try {
      return await this.send(account, chatId, caption, storeTemporary, {
        path,
        kind,
      });
    } catch (e) {
      uncertain = e instanceof TelegramError && e.ambiguous;
      throw e;
    } finally {
      if (!uncertain) await rm(temporary, { recursive: true, force: true });
    }
  }
  private async cleanupOutbound(accountId: string) {
    const parent = join(this.settings.paths().data, accountId, 'outbound');
    try {
      for (const entry of (
        await readdir(parent, { withFileTypes: true })
      ).slice(0, 100)) {
        if (
          !entry.isDirectory() ||
          !z.string().uuid().safeParse(entry.name).success
        )
          continue;
        const path = join(parent, entry.name),
          info = await lstat(path);
        if (!info.isSymbolicLink() && info.mtimeMs < Date.now() - 86400000)
          await rm(path, { recursive: true, force: true });
      }
    } catch {
      /* missing staging directory or bounded cleanup failure does not affect a session */
    }
  }
  async send(
    account: ChannelAccount,
    chatId: string,
    text: string,
    storeTemporary: (id: string) => Promise<void>,
    media?: { path: string; kind: 'document' | 'audio' },
  ) {
    const entry = this.client(account);
    if ((!media && !text.trim()) || text.length > (media ? 1024 : 2000))
      throw new TelegramError('TELEGRAM_INVALID_REQUEST');
    if (!entry.networkReady) throw new TelegramError('TELEGRAM_NOT_CONNECTED');
    const chat = tdChatSchema.parse(
      await entry.client.request({
        '@type': 'getChat',
        chat_id: tdNumber(chatId),
      }),
    );
    const rights = await this.permissions(entry, chat);
    if (
      !tdChatAllowed(chat) ||
      !rights.easychat_can_send ||
      rights.easychat_topic_unsupported
    )
      throw new TelegramError('TELEGRAM_PERMISSION_DENIED');
    const result = tdMessageSchema.parse(
      await entry.client.request(
        {
          '@type': 'sendMessage',
          chat_id: tdNumber(chatId),
          topic_id: null,
          reply_to: null,
          options: null,
          reply_markup: null,
          input_message_content: media
            ? media.kind === 'document'
              ? {
                  '@type': 'inputMessageDocument',
                  document: {
                    '@type': 'inputDocument',
                    document: { '@type': 'inputFileLocal', path: media.path },
                    thumbnail: null,
                    disable_content_type_detection: true,
                  },
                  caption: { '@type': 'formattedText', text, entities: [] },
                }
              : {
                  '@type': 'inputMessageAudio',
                  audio: {
                    '@type': 'inputAudio',
                    audio: { '@type': 'inputFileLocal', path: media.path },
                    album_cover_thumbnail: null,
                    duration: 0,
                    title: '',
                    performer: '',
                  },
                  caption: { '@type': 'formattedText', text, entities: [] },
                }
            : {
                '@type': 'inputMessageText',
                text: { '@type': 'formattedText', text, entities: [] },
                link_preview_options: null,
                clear_draft: false,
              },
        },
        'send',
      ),
    );
    if (result.chat_id !== chatId || !result.is_outgoing)
      throw new TelegramError('TELEGRAM_SEND_UNKNOWN', true);
    if (!result.sending_state) return result;
    if (result.sending_state['@type'] === 'messageSendingStateFailed')
      throw tdError(
        result.sending_state.error as { code?: unknown; message?: unknown },
        'send',
      );
    await storeTemporary(result.id);
    const finish = (event: TdObject) => {
      if (event['@type'] === 'updateMessageSendFailed')
        throw tdError(
          event.error as { code?: unknown; message?: unknown },
          'send',
        );
      const confirmed = tdMessageSchema.parse(event.message);
      if (
        confirmed.chat_id !== chatId ||
        !confirmed.is_outgoing ||
        confirmed.sending_state
      )
        throw new TelegramError('TELEGRAM_SEND_UNKNOWN', true);
      return confirmed;
    };
    const early = entry.sending.get(result.id);
    if (early) {
      entry.sending.delete(result.id);
      return finish(early);
    }
    return new Promise<z.infer<typeof tdMessageSchema>>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.listeners.delete(listener);
        reject(new TelegramError('TELEGRAM_SEND_UNKNOWN', true));
      }, 15000);
      const listener = (event: TdObject) => {
        if (String(event.old_message_id) !== result.id) return;
        clearTimeout(timer);
        entry.listeners.delete(listener);
        entry.sending.delete(result.id);
        try {
          resolve(finish(event));
        } catch (error) {
          reject(error);
        }
      };
      entry.listeners.add(listener);
    });
  }
}
