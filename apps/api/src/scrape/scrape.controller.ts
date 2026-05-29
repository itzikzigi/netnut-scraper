import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { CreateScrapeDto } from './dto/create-scrape.dto';
import { ScrapeService } from './scrape.service';

@Controller('scrape')
export class ScrapeController {
  constructor(private readonly scrape: ScrapeService) {}

  @Post()
  async submit(
    @Body() dto: CreateScrapeDto,
    @Query('wait') wait: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const isSync = wait === 'true' || wait === '1';
    const result = await this.scrape.submit(dto.url, isSync);
    res.status(isSync ? HttpStatus.OK : HttpStatus.ACCEPTED);
    return result;
  }

  @Get(':id')
  getStatus(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.scrape.getStatus(id);
  }
}
