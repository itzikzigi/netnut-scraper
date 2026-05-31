import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ApiModule } from './api.module';

async function bootstrap() {
  const app = await NestFactory.create(ApiModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Fire OnModuleDestroy hooks on SIGTERM/SIGINT so the Redis subscriber
  // is closed cleanly on shutdown (k8s rolling updates send SIGTERM).
  app.enableShutdownHooks();

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);
  Logger.log(`API listening on http://localhost:${port}`, 'Bootstrap');
}
bootstrap();
