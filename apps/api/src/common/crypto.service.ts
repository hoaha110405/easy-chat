import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ConfigService } from '../config/config.service';
export const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function constantEquals(a: string, b: string) {
  return timingSafeEqual(
    Buffer.from(hash(a), 'hex'),
    Buffer.from(hash(b), 'hex'),
  );
}
@Injectable()
export class CryptoService {
  constructor(private readonly config: ConfigService) {}
  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from(this.config.env.TOKEN_ENCRYPTION_KEY, 'hex'),
      iv,
    );
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }
  decrypt(value: string): string {
    const [version, iv, tag, data] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !data)
      throw new Error('Invalid encrypted value');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(this.config.env.TOKEN_ENCRYPTION_KEY, 'hex'),
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
