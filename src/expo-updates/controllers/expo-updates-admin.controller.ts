import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  EXPO_UPDATES_CONFIG,
  limiteUploadBytes,
} from 'src/expo-updates/config/expo-updates.config';
import type { ExpoUpdatesConfig } from 'src/expo-updates/config/expo-updates.config';
import {
  PublicarUpdateDto,
  RepublicarUpdateDto,
} from 'src/expo-updates/dto/publicar-update.dto';
import { ReleaseInfo } from 'src/expo-updates/interfaces/expo-updates.interfaces';
import { ExpoUpdatesManifestService } from 'src/expo-updates/services/expo-updates-manifest.service';
import { ExpoUpdatesReleasesService } from 'src/expo-updates/services/expo-updates-releases.service';
import { AdminTokenGuard } from 'src/infra/guards/admin-token.guard';

/**
 * Endpoints administrativos de publicação OTA.
 * Protegidos por `x-admin-token` (ADMIN_PANEL_TOKEN) — são chamados pelo
 * script `scripts/publicar-update.mjs`, não pelo app.
 */
@ApiTags('expo-updates')
@ApiHeader({ name: 'x-admin-token', required: true })
@Controller('expo-updates/admin')
@UseGuards(AdminTokenGuard)
export class ExpoUpdatesAdminController {
  constructor(
    private readonly releases: ExpoUpdatesReleasesService,
    private readonly manifestService: ExpoUpdatesManifestService,
    @Inject(EXPO_UPDATES_CONFIG) private readonly config: ExpoUpdatesConfig,
  ) {}

  /** Estado geral: pasta, assinatura, URL pública e runtimes publicados. */
  @Get('status')
  async status() {
    const releases = await this.releases.listarReleases();
    const porRuntime = new Map<string, ReleaseInfo[]>();
    for (const r of releases) {
      porRuntime.set(r.runtimeVersion, [
        ...(porRuntime.get(r.runtimeVersion) ?? []),
        r,
      ]);
    }
    return {
      diretorio: this.releases.diretorioBase,
      urlPublica: this.config.urlPublica,
      assinaturaHabilitada: this.manifestService.assinaturaHabilitada,
      keyId: this.config.keyId,
      limiteUploadMb: Math.round(this.config.limiteUploadBytes / 1024 / 1024),
      runtimes: [...porRuntime.entries()].map(([runtimeVersion, lista]) => ({
        runtimeVersion,
        totalReleases: lista.length,
        ativa: lista.find((r) => r.ativa)
          ? this.resumo(lista.find((r) => r.ativa)!)
          : null,
      })),
    };
  }

  @Get('releases')
  async listar(@Query('runtimeVersion') runtimeVersion?: string) {
    const lista = await this.releases.listarReleases(runtimeVersion);
    return lista.map((r) => this.resumo(r));
  }

  /**
   * Publica um release: multipart com campo `arquivo` (zip da pasta gerada por
   * `npx expo export`), `runtimeVersion` e `descricao` opcional.
   */
  @Post('publicar')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('arquivo', { limits: { fileSize: limiteUploadBytes() } }),
  )
  async publicar(
    @Body() body: PublicarUpdateDto,
    @UploadedFile() arquivo: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    if (!arquivo?.buffer?.length) {
      throw new BadRequestException('Envie o zip no campo multipart "arquivo"');
    }

    const release = await this.releases.publicarZip(arquivo.buffer, {
      runtimeVersion: body.runtimeVersion,
      descricao: body.descricao,
      origem: `upload:${arquivo.originalname ?? 'sem-nome'}`,
    });

    // Calcula os hashes agora: falha aqui é melhor que no primeiro app
    await this.manifestService.preaquecer(release, this.urlBase(req));

    return this.resumo(release);
  }

  /** Rollback: republica um release antigo como o mais recente. */
  @Post('releases/:runtimeVersion/:nome/republicar')
  @HttpCode(HttpStatus.CREATED)
  async republicar(
    @Param('runtimeVersion') runtimeVersion: string,
    @Param('nome') nome: string,
    @Body() body: RepublicarUpdateDto,
    @Req() req: Request,
  ) {
    const release = await this.releases.republicar(
      runtimeVersion,
      nome,
      body?.descricao,
    );
    await this.manifestService.preaquecer(release, this.urlBase(req));
    return this.resumo(release);
  }

  /** Kill-switch: deixa de servir este release (aparelhos que já baixaram mantêm). */
  @Post('releases/:runtimeVersion/:nome/desativar')
  async desativar(
    @Param('runtimeVersion') runtimeVersion: string,
    @Param('nome') nome: string,
  ) {
    return this.resumo(await this.releases.desativar(runtimeVersion, nome));
  }

  @Post('releases/:runtimeVersion/:nome/reativar')
  async reativar(
    @Param('runtimeVersion') runtimeVersion: string,
    @Param('nome') nome: string,
  ) {
    return this.resumo(await this.releases.reativar(runtimeVersion, nome));
  }

  /** Remove do disco (limpeza). Irreversível. */
  @Delete('releases/:runtimeVersion/:nome')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remover(
    @Param('runtimeVersion') runtimeVersion: string,
    @Param('nome') nome: string,
  ): Promise<void> {
    await this.releases.remover(runtimeVersion, nome);
  }

  private resumo(r: ReleaseInfo) {
    return {
      runtimeVersion: r.runtimeVersion,
      nome: r.nome,
      ativa: r.ativa,
      criadoEm: r.criadoEm,
      plataformas: r.plataformas,
      descricao: r.descricao ?? null,
      origem: r.origem ?? null,
      tamanhoMb:
        r.tamanhoBytes != null
          ? Number((r.tamanhoBytes / 1024 / 1024).toFixed(2))
          : null,
    };
  }

  private urlBase(req: Request): string {
    if (this.config.urlPublica) return this.config.urlPublica;
    const proto =
      (req.headers['x-forwarded-proto'] as string | undefined)
        ?.split(',')[0]
        ?.trim() || req.protocol;
    const host =
      (req.headers['x-forwarded-host'] as string | undefined)
        ?.split(',')[0]
        ?.trim() || req.get('host');
    return `${proto}://${host}`;
  }
}
