import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import type { Request, Response } from 'express';
import { promises as fs } from 'fs';
import { extname } from 'path';
import { EXPO_UPDATES_CONFIG } from 'src/expo-updates/config/expo-updates.config';
import type { ExpoUpdatesConfig } from 'src/expo-updates/config/expo-updates.config';
import { contentTypePorExtensao } from 'src/expo-updates/helpers/expo-updates.helpers';
import { ExpoUpdatesManifestService } from 'src/expo-updates/services/expo-updates-manifest.service';
import { ExpoUpdatesReleasesService } from 'src/expo-updates/services/expo-updates-releases.service';

class AssetQueryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  runtimeVersion: string;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  release: string;

  @IsString()
  asset: string;

  /** Extensão declarada no metadata.json (arquivos de asset não têm extensão). */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{1,10}$/)
  ext?: string;
}

function primeiroHeader(
  valor: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(valor)) return valor[0];
  return valor;
}

/**
 * Endpoints PÚBLICOS consumidos pelo `expo-updates` embutido no app.
 * Não usam JWT: o app checa updates antes de qualquer login.
 *
 * - GET /api/expo-updates/manifest → manifest/diretiva (Expo Updates Protocol)
 * - GET /api/expo-updates/assets   → bundle e assets (imutáveis, cache longo)
 */
@ApiTags('expo-updates')
@Controller('expo-updates')
export class ExpoUpdatesController {
  constructor(
    private readonly manifestService: ExpoUpdatesManifestService,
    private readonly releases: ExpoUpdatesReleasesService,
    @Inject(EXPO_UPDATES_CONFIG) private readonly config: ExpoUpdatesConfig,
  ) {}

  @Get('manifest')
  @ApiExcludeEndpoint()
  async manifest(@Req() req: Request, @Res() res: Response): Promise<void> {
    const protocolo =
      primeiroHeader(req.headers['expo-protocol-version']) === '1' ? 1 : 0;

    const resposta = await this.manifestService.responder({
      protocolVersion: protocolo,
      platform: primeiroHeader(req.headers['expo-platform'])?.toLowerCase(),
      runtimeVersion: primeiroHeader(req.headers['expo-runtime-version']),
      currentUpdateId: primeiroHeader(req.headers['expo-current-update-id']),
      expectSignature: !!primeiroHeader(req.headers['expo-expect-signature']),
      urlBase: this.resolverUrlBase(req),
    });

    res.status(resposta.status);
    for (const [k, v] of Object.entries(resposta.headers)) {
      res.setHeader(k, v);
    }
    if (resposta.corpo === undefined) {
      res.end();
    } else {
      res.send(resposta.corpo);
    }
  }

  @Get('assets')
  @ApiExcludeEndpoint()
  async asset(
    @Query() query: AssetQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const release = await this.releases.obterRelease(
      query.runtimeVersion,
      query.release,
    );
    const caminho = this.releases.resolverArquivo(release, query.asset);

    try {
      const stat = await fs.stat(caminho);
      if (!stat.isFile()) throw new Error('não é arquivo');
    } catch {
      throw new NotFoundException('Asset não encontrado');
    }

    const ext = extname(caminho).replace(/^\./, '') || query.ext || '';
    res.setHeader(
      'content-type',
      ext === 'hbc' || ext === 'bundle' || ext === 'js'
        ? 'application/javascript'
        : contentTypePorExtensao(ext),
    );
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.sendFile(caminho);
  }

  private resolverUrlBase(req: Request): string {
    if (this.config.urlPublica) return this.config.urlPublica;
    const proto =
      primeiroHeader(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim() ||
      req.protocol;
    const host =
      primeiroHeader(req.headers['x-forwarded-host'])?.split(',')[0]?.trim() ||
      req.get('host');
    return `${proto}://${host}`;
  }
}
