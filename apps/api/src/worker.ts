import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { PersonalWorkerModule } from './modules/zalo-personal/personal-worker.module';
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(PersonalWorkerModule);
  app.enableShutdownHooks();
}
void bootstrap().catch(() => {
  new Logger('PersonalWorker').error(
    'Worker startup failed. Check PostgreSQL availability, configuration, and whether another worker is running.',
  );
  process.exitCode = 1;
});
