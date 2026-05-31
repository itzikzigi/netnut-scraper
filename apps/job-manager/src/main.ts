import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { JobManagerModule } from './job-manager.module';

async function bootstrap() {
  const app = await NestFactory.create(JobManagerModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Fire OnModuleDestroy hooks on SIGTERM/SIGINT so TypeORM/BullMQ
  // connections drain cleanly on shutdown.
  app.enableShutdownHooks();

  const port = process.env.JOB_MANAGER_PORT ?? 3001;
  await app.listen(port);
  Logger.log(`Job Manager listening on http://localhost:${port}`, 'Bootstrap');
}
bootstrap();
