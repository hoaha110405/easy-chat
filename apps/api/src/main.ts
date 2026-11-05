import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { configureApp } from './configure-app';
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  configureApp(app);
  app.enableShutdownHooks();
  const port = app.get(ConfigService).env.PORT;
  await app.listen(port, '0.0.0.0');
}
void bootstrap();
