import { Inject, Injectable } from '@nestjs/common';
import {
  PERSONAL_ADAPTER_FACTORY,
  type PersonalAdapterFactory,
  type PersonalAdapter,
} from './personal-adapter';
export type ActiveSession = {
  adapter: PersonalAdapter;
  generation: number;
  ready: boolean;
  profileSync: {
    busy: boolean;
    nextAt: number;
    retryAt: number;
    cursor?: string;
    complete: boolean;
    revision: number;
  };
};
@Injectable()
export class ZaloSessionManager {
  private readonly sessions = new Map<string, ActiveSession>();
  constructor(
    @Inject(PERSONAL_ADAPTER_FACTORY)
    private readonly factory: PersonalAdapterFactory,
  ) {}
  create(id: string, generation: number) {
    this.disconnect(id);
    const entry: ActiveSession = {
      adapter: this.factory(),
      generation,
      ready: false,
      profileSync: {
        busy: false,
        nextAt: 0,
        retryAt: 0,
        complete: false,
        revision: 0,
      },
    };
    this.sessions.set(id, entry);
    return entry;
  }
  get(id: string) {
    return this.sessions.get(id);
  }
  disconnect(id: string) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    session?.adapter.disconnect();
  }
  disconnectAll() {
    for (const id of this.sessions.keys()) this.disconnect(id);
  }
  entries() {
    return this.sessions.entries();
  }
}
