import { MediaStore } from './media-store';
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
    MediaStore,
    AuthService,
    AdminGuard,
  ],
  exports: [
    ConfigService,
    PrismaService,
    CryptoService,
    MediaStore,
    AuthService,
    AdminGuard,
  ],
})
export class CoreModule {}
