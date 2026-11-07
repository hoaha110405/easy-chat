import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { describeWorkerStartupFailure } from './common/worker-startup-error';
import { PersonalWorkerModule } from './modules/zalo-personal/personal-worker.module';
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(PersonalWorkerModule);
  app.enableShutdownHooks();
}
void bootstrap().catch((error: unknown) => {
  const failure = describeWorkerStartupFailure(error);
  new Logger('PersonalWorker').error(`[${failure.code}] ${failure.message}`);
  process.exitCode = 1;
});
