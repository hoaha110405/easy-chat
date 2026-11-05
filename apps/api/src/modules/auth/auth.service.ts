import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { PrismaService } from '../../database/prisma.service';
import { ConfigService } from '../../config/config.service';
import { constantEquals, hash } from '../../common/crypto.service';
import { ApiError } from '../../common/api-error';
export const ADMIN_OWNER_ID = 'administrator';
export const SESSION_COOKIE = 'zalo_admin';
export type AdminRequest = Request & {
  adminSessionId?: string;
  adminOwnerId?: string;
};
@Injectable()
export class AuthService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
  ) {}
  private sign(token: string) {
    return createHmac('sha256', this.config.env.SESSION_SECRET)
      .update(token)
      .digest('base64url');
  }
  private get cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/api',
    };
  }
  async login(password: string, response: Response) {
    if (!constantEquals(password, this.config.env.ADMIN_PASSWORD))
      throw new ApiError(
        401,
        'INVALID_CREDENTIALS',
        'Incorrect administrator password.',
      );
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await this.db.adminSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    await this.db.adminSession.create({ data: { id: hash(token), expiresAt } });
    response.cookie(SESSION_COOKIE, `${token}.${this.sign(token)}`, {
      ...this.cookieOptions,
      expires: expiresAt,
    });
  }
  async session(request: Request) {
    const value: unknown = request.cookies?.[SESSION_COOKIE];
    if (typeof value !== 'string') return null;
    const [token, signature] = value.split('.');
    if (!token || !signature || !constantEquals(signature, this.sign(token)))
      return null;
    const session = await this.db.adminSession.findUnique({
      where: { id: hash(token) },
    });
    return session && session.expiresAt > new Date() ? session : null;
  }
  async logout(request: Request, response: Response) {
    const session = await this.session(request);
    if (session)
      await this.db.adminSession.deleteMany({ where: { id: session.id } });
    response.clearCookie(SESSION_COOKIE, this.cookieOptions);
  }
  assertOrigin(request: Request) {
    if (request.get('origin') !== new URL(this.config.env.FRONTEND_URL).origin)
      throw new ApiError(
        403,
        'INVALID_ORIGIN',
        'This request must come from the administrator interface.',
      );
  }
}
