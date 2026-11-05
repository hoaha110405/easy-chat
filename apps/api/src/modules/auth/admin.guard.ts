import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthService, ADMIN_OWNER_ID, type AdminRequest } from './auth.service';
import { ApiError } from '../../common/api-error';
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const session = await this.auth.session(request);
    if (!session)
      throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
      this.auth.assertOrigin(request);
    request.adminSessionId = session.id;
    request.adminOwnerId = ADMIN_OWNER_ID;
    return true;
  }
}
