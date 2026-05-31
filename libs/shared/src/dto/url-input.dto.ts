import { IsString, IsUrl, MaxLength } from 'class-validator';

/**
 * Shared input contract for endpoints that accept a single target URL
 * (`POST /scrape`, `POST /jobs`). Extended per-app so each boundary keeps a
 * concrete class for class-validator (decorators don't survive `Omit`/`Pick`)
 * while still sharing one definition — and can diverge later if it must.
 */
export class UrlInputDto {
  @IsString()
  @IsUrl({ require_protocol: true, require_valid_protocol: true })
  @MaxLength(2048)
  url!: string;
}
