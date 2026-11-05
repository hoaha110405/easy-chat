import { Global, Module } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from './crypto.service';
import { AuthService } from '../modules/auth/auth.service';
import { AdminGuard } from '../modules/auth/admin.guard';
@Global()
@Module({
  providers: [
    ConfigService,
    PrismaService,
    CryptoService,
    AuthService,
    AdminGuard,
  ],
  exports: [
    ConfigService,
    PrismaService,
    CryptoService,
    AuthService,
    AdminGuard,
  ],
})
export class CoreModule {}
