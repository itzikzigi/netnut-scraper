import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ScraperModule } from './scraper.module';

async function bootstrap() {
  const app = await NestFactory.create(ScraperModule);

  const port = process.env.SCRAPER_PORT ?? 3002;
  await app.listen(port);
  Logger.log(`Scraper worker up · health on http://localhost:${port}`, 'Bootstrap');
}
bootstrap();
