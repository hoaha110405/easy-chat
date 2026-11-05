import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/api-error';
import { ConfigService } from '../../config/config.service';
import {
  FACEBOOK_PERSONAL_CAPABILITIES,
  FACEBOOK_PERSONAL_UNSUPPORTED_MESSAGE,
  type FacebookPersonalCapabilities,
  type FacebookPersonalOperation,
} from './facebook-personal.adapter';

export type FacebookPersonalStatus = {
  enabled: boolean;
  status: 'UNSUPPORTED';
  experimental: true;
  reasonCode: 'FACEBOOK_PERSONAL_UNSUPPORTED';
  message: string;
  capabilities: FacebookPersonalCapabilities;
  library: null;
};

@Injectable()
export class FacebookPersonalService {
  constructor(private readonly config: ConfigService) {}

  status(): FacebookPersonalStatus {
    return {
      enabled: this.config.env.FACEBOOK_PERSONAL_ENABLED,
      status: 'UNSUPPORTED',
      experimental: true,
      reasonCode: 'FACEBOOK_PERSONAL_UNSUPPORTED',
      message: FACEBOOK_PERSONAL_UNSUPPORTED_MESSAGE,
      capabilities: FACEBOOK_PERSONAL_CAPABILITIES,
      library: null,
    };
  }

  capabilities() {
    return this.status();
  }

  assertSupported(operation: FacebookPersonalOperation): never {
    throw new ApiError(
      501,
      operation === 'e2ee'
        ? 'FACEBOOK_PERSONAL_E2EE_UNSUPPORTED'
        : 'FACEBOOK_PERSONAL_UNSUPPORTED',
      FACEBOOK_PERSONAL_UNSUPPORTED_MESSAGE,
    );
  }
}
