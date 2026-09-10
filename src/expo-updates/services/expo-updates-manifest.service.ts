import { Inject, Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { EXPO_UPDATES_CONFIG } from 'src/expo-updates/config/expo-updates.config';
import type { ExpoUpdatesConfig } from 'src/expo-updates/config/expo-updates.config';
import {
  assinarRsaSha256,
  contentTypePorExtensao,
  hashParaUuid,
  md5Hex,
  montarHeaderAssinatura,
  montarMultipartMixed,
  normalizarCaminhoRelativo,
  sha256Base64Url,
  sha256Hex,
} from 'src/expo-updates/helpers/expo-updates.helpers';
import {
  AssetManifest,
  ManifestExpo,
  PLATAFORMAS_EXPO,
  PlataformaExpo,
  ReleaseInfo,
  RequisicaoManifest,
  RespostaManifest,
} from 'src/expo-updates/interfaces/expo-updates.interfaces';
import { ExpoUpdatesReleasesService } from 'src/expo-updates/services/expo-updates-releases.service';

const HEADERS_PROTOCOLO = (versao: 0 | 1): Record<string, string> => ({
  'expo-protocol-version': String(versao),
  'expo-sfv-version': '0',
  'cache-control': 'private, max-age=0',
});

/**
 * Implementa o lado servidor do Expo Updates Protocol
 * (https://docs.expo.dev/technical-specs/expo-updates-1/).
 *
 * Manifests são calculados uma vez por (release, plataforma, urlBase) e mantidos
 * em memória — releases são imutáveis, então o cache nunca expira.
 */
@Injectable()
export class ExpoUpdatesManifestService {
  private readonly logger = new Logger(ExpoUpdatesManifestService.name);
  private readonly cache = new Map<string, Promise<ManifestExpo>>();

  constructor(
    private readonly releases: ExpoUpdatesReleasesService,
    @Inject(EXPO_UPDATES_CONFIG) private readonly config: ExpoUpdatesConfig,
  ) {}

  get assinaturaHabilitada(): boolean {
    return !!this.config.chavePrivadaPem;
  }

  async responder(req: RequisicaoManifest): Promise<RespostaManifest> {
    const plataforma = req.platform as PlataformaExpo;
    if (!PLATAFORMAS_EXPO.includes(plataforma)) {
      return this.erro(400, 'Header expo-platform inválido (android|ios)');
    }
    if (!req.runtimeVersion) {
      return this.erro(400, 'Header expo-runtime-version ausente');
    }
    if (req.expectSignature && !this.assinaturaHabilitada) {
      this.logger.error(
        'App pediu manifest assinado, mas EXPO_UPDATES_PRIVATE_KEY_* não está configurada',
      );
      return this.erro(
        400,
        'Servidor sem chave de code signing configurada para assinar o manifest',
      );
    }

    const release = await this.releases.releaseAtiva(
      req.runtimeVersion,
      plataforma,
    );
    if (!release) {
      // 204 = "sem update disponível" para qualquer versão do protocolo
      return { status: 204, headers: HEADERS_PROTOCOLO(req.protocolVersion) };
    }

    const manifest = await this.obterManifest(release, plataforma, req.urlBase);

    const jaAtualizado =
      !!req.currentUpdateId &&
      req.currentUpdateId.toLowerCase() === manifest.id;

    if (req.protocolVersion === 1) {
      return jaAtualizado
        ? this.responderDiretiva(
            { type: 'noUpdateAvailable' },
            req.expectSignature,
          )
        : this.responderManifestV1(manifest, req.expectSignature);
    }

    // Protocolo 0 (SDKs antigos): sempre JSON puro; o app ignora id repetido
    return this.responderManifestV0(manifest, req.expectSignature);
  }

  /** Pré-calcula (e cacheia) o manifest de todas as plataformas do release. */
  async preaquecer(release: ReleaseInfo, urlBase: string): Promise<void> {
    await Promise.all(
      release.plataformas.map((p) => this.obterManifest(release, p, urlBase)),
    );
  }

  obterManifest(
    release: ReleaseInfo,
    plataforma: PlataformaExpo,
    urlBase: string,
  ): Promise<ManifestExpo> {
    const chave = `${release.caminho}|${plataforma}|${urlBase}`;
    let pendente = this.cache.get(chave);
    if (!pendente) {
      pendente = this.montarManifest(release, plataforma, urlBase).catch(
        (err) => {
          this.cache.delete(chave);
          throw err;
        },
      );
      this.cache.set(chave, pendente);
    }
    return pendente;
  }

  // ───────────────────────────── montagem ──────────────────────────────

  private async montarManifest(
    release: ReleaseInfo,
    plataforma: PlataformaExpo,
    urlBase: string,
  ): Promise<ManifestExpo> {
    const inicio = Date.now();
    const { bruto, metadata } = await this.releases.lerMetadata(release);
    const pm = metadata.fileMetadata[plataforma];
    if (!pm) {
      throw new Error(
        `Release ${release.runtimeVersion}/${release.nome} não contém bundle de ${plataforma}`,
      );
    }

    // id único por release (inclui o nome da pasta para que um rollback
    // republicado gere um id diferente do original com o mesmo conteúdo)
    const id = hashParaUuid(
      sha256Hex(
        Buffer.concat([
          Buffer.from(`${release.runtimeVersion}/${release.nome}\n`, 'utf8'),
          bruto,
        ]),
      ),
    );

    const launchAsset = await this.montarAsset(
      release,
      pm.bundle,
      null,
      true,
      urlBase,
    );
    const assets = await Promise.all(
      (pm.assets ?? []).map((a) =>
        this.montarAsset(release, a.path, a.ext, false, urlBase),
      ),
    );
    const expoClient = await this.releases.lerExpoConfig(release);

    this.logger.log(
      `Manifest montado: ${release.runtimeVersion}/${release.nome} ${plataforma} | ` +
        `${assets.length} assets | ${Date.now() - inicio}ms`,
    );

    return {
      id,
      createdAt: new Date(release.criadoEm).toISOString(),
      runtimeVersion: release.runtimeVersion,
      launchAsset,
      assets,
      metadata: {},
      extra: expoClient ? { expoClient } : {},
    };
  }

  private async montarAsset(
    release: ReleaseInfo,
    caminhoBruto: string,
    ext: string | null,
    isLaunchAsset: boolean,
    urlBase: string,
  ): Promise<AssetManifest> {
    // metadata.json gerado no Windows traz "assets\\abc" — normalizar para "/"
    const caminhoRelativo = normalizarCaminhoRelativo(caminhoBruto);
    const conteudo = await fs.readFile(join(release.caminho, caminhoRelativo));
    const extensao = isLaunchAsset ? 'bundle' : (ext ?? '').replace(/^\./, '');

    const query = new URLSearchParams({
      runtimeVersion: release.runtimeVersion,
      release: release.nome,
      asset: caminhoRelativo,
    });
    // arquivos de asset do Expo não têm extensão no nome — o endpoint usa `ext`
    // para responder com o content-type correto
    if (!isLaunchAsset && extensao) query.set('ext', extensao);

    return {
      hash: sha256Base64Url(conteudo),
      key: md5Hex(conteudo),
      fileExtension: `.${extensao}`,
      contentType: isLaunchAsset
        ? 'application/javascript'
        : contentTypePorExtensao(ext),
      url: `${urlBase}/api/expo-updates/assets?${query.toString()}`,
    };
  }

  // ───────────────────────────── respostas ─────────────────────────────

  private assinar(conteudo: string): Record<string, string> {
    if (!this.assinaturaHabilitada) return {};
    const sig = assinarRsaSha256(conteudo, this.config.chavePrivadaPem!);
    return { 'expo-signature': montarHeaderAssinatura(sig, this.config.keyId) };
  }

  private responderManifestV1(
    manifest: ManifestExpo,
    assinar: boolean,
  ): RespostaManifest {
    const json = JSON.stringify(manifest);
    const { boundary, corpo } = montarMultipartMixed([
      {
        nome: 'manifest',
        corpo: json,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(assinar ? this.assinar(json) : {}),
        },
      },
      {
        nome: 'extensions',
        corpo: JSON.stringify({ assetRequestHeaders: {} }),
        headers: { 'Content-Type': 'application/json' },
      },
    ]);

    return {
      status: 200,
      headers: {
        ...HEADERS_PROTOCOLO(1),
        'content-type': `multipart/mixed; boundary=${boundary}`,
      },
      corpo,
    };
  }

  private responderDiretiva(
    diretiva: Record<string, unknown>,
    assinar: boolean,
  ): RespostaManifest {
    const json = JSON.stringify(diretiva);
    const { boundary, corpo } = montarMultipartMixed([
      {
        nome: 'directive',
        corpo: json,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(assinar ? this.assinar(json) : {}),
        },
      },
    ]);

    return {
      status: 200,
      headers: {
        ...HEADERS_PROTOCOLO(1),
        'content-type': `multipart/mixed; boundary=${boundary}`,
      },
      corpo,
    };
  }

  private responderManifestV0(
    manifest: ManifestExpo,
    assinar: boolean,
  ): RespostaManifest {
    const json = JSON.stringify(manifest);
    return {
      status: 200,
      headers: {
        ...HEADERS_PROTOCOLO(0),
        'content-type': 'application/json; charset=utf-8',
        ...(assinar ? this.assinar(json) : {}),
      },
      corpo: json,
    };
  }

  private erro(status: number, mensagem: string): RespostaManifest {
    return {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      corpo: JSON.stringify({ statusCode: status, message: mensagem }),
    };
  }
}
