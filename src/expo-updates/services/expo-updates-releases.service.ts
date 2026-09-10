import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { EXPO_UPDATES_CONFIG } from 'src/expo-updates/config/expo-updates.config';
import type { ExpoUpdatesConfig } from 'src/expo-updates/config/expo-updates.config';
import {
  SEGMENTO_SEGURO,
  caminhoRelativoSeguro,
  gerarNomeRelease,
  nomeReleaseParaData,
  normalizarCaminhoRelativo,
} from 'src/expo-updates/helpers/expo-updates.helpers';
import {
  MetadataExport,
  PLATAFORMAS_EXPO,
  PlataformaExpo,
  ReleaseInfo,
  ReleaseMeta,
} from 'src/expo-updates/interfaces/expo-updates.interfaces';

const ARQUIVO_RELEASE = 'release.json';
const ARQUIVO_METADATA = 'metadata.json';
const ARQUIVO_EXPO_CONFIG = 'expoConfig.json';
const MARCADOR_DESATIVADA = '.desativada';

/**
 * Armazenamento em disco dos releases OTA.
 *
 * Layout: `<EXPO_UPDATES_DIR>/<runtimeVersion>/<nomeRelease>/` contendo a saída
 * íntegra de `npx expo export` (metadata.json, expoConfig.json, _expo/, assets/)
 * mais `release.json` (nossos metadados) e, opcionalmente, o marcador
 * `.desativada`.
 *
 * Releases são imutáveis depois de publicados: rollback é feito republicando
 * um release antigo como um release novo (ver `republicar`).
 */
@Injectable()
export class ExpoUpdatesReleasesService {
  private readonly logger = new Logger(ExpoUpdatesReleasesService.name);

  constructor(
    @Inject(EXPO_UPDATES_CONFIG) private readonly config: ExpoUpdatesConfig,
  ) {}

  get diretorioBase(): string {
    return this.config.diretorio;
  }

  // ───────────────────────────── consulta ──────────────────────────────

  async listarRuntimeVersions(): Promise<string[]> {
    const entradas = await this.lerDiretorio(this.config.diretorio);
    return entradas
      .filter((e) => e.isDirectory() && SEGMENTO_SEGURO.test(e.name))
      .map((e) => e.name)
      .sort();
  }

  async listarReleases(runtimeVersion?: string): Promise<ReleaseInfo[]> {
    const versoes = runtimeVersion
      ? [this.validarSegmento(runtimeVersion, 'runtimeVersion')]
      : await this.listarRuntimeVersions();

    const resultado: ReleaseInfo[] = [];
    for (const versao of versoes) {
      const dir = join(this.config.diretorio, versao);
      const entradas = await this.lerDiretorio(dir);
      const nomes = entradas
        .filter((e) => e.isDirectory() && SEGMENTO_SEGURO.test(e.name))
        .map((e) => e.name)
        .sort()
        .reverse();

      for (const nome of nomes) {
        const info = await this.carregarRelease(versao, nome);
        if (info) resultado.push(info);
      }
    }
    return resultado;
  }

  /** Release ativa mais recente para runtime + plataforma, ou null. */
  async releaseAtiva(
    runtimeVersion: string,
    platform: PlataformaExpo,
  ): Promise<ReleaseInfo | null> {
    if (!SEGMENTO_SEGURO.test(runtimeVersion)) return null;
    const releases = await this.listarReleases(runtimeVersion);
    return (
      releases.find((r) => r.ativa && r.plataformas.includes(platform)) ?? null
    );
  }

  async obterRelease(
    runtimeVersion: string,
    nome: string,
  ): Promise<ReleaseInfo> {
    const info = await this.carregarRelease(
      this.validarSegmento(runtimeVersion, 'runtimeVersion'),
      this.validarSegmento(nome, 'release'),
    );
    if (!info) {
      throw new NotFoundException(
        `Release ${runtimeVersion}/${nome} não encontrado`,
      );
    }
    return info;
  }

  async lerMetadata(release: ReleaseInfo): Promise<{
    bruto: Buffer;
    metadata: MetadataExport;
  }> {
    const bruto = await fs.readFile(join(release.caminho, ARQUIVO_METADATA));
    return { bruto, metadata: JSON.parse(bruto.toString('utf8')) };
  }

  async lerExpoConfig(
    release: ReleaseInfo,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const bruto = await fs.readFile(
        join(release.caminho, ARQUIVO_EXPO_CONFIG),
        'utf8',
      );
      return JSON.parse(bruto);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve o caminho absoluto de um arquivo dentro do release, garantindo que
   * ele não escape da pasta (path traversal).
   */
  resolverArquivo(release: ReleaseInfo, caminhoRelativo: string): string {
    const normalizado = normalizarCaminhoRelativo(caminhoRelativo);
    if (!caminhoRelativoSeguro(normalizado)) {
      throw new BadRequestException('Caminho de asset inválido');
    }
    const absoluto = resolve(release.caminho, normalizado);
    const raiz = resolve(release.caminho) + sep;
    if (!absoluto.startsWith(raiz)) {
      throw new BadRequestException('Caminho de asset inválido');
    }
    return absoluto;
  }

  // ───────────────────────────── publicação ────────────────────────────

  /**
   * Extrai o zip de `npx expo export` para um novo release.
   * Aceita metadata.json na raiz do zip ou dentro de uma única pasta (ex.: dist/).
   */
  async publicarZip(
    zipBuffer: Buffer,
    opts: { runtimeVersion: string; descricao?: string; origem?: string },
  ): Promise<ReleaseInfo> {
    const runtimeVersion = this.validarSegmento(
      opts.runtimeVersion,
      'runtimeVersion',
    );

    let zip: AdmZip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch (err) {
      throw new BadRequestException(
        `Arquivo enviado não é um zip válido: ${(err as Error).message}`,
      );
    }

    const entradas = zip
      .getEntries()
      .filter((e) => !e.isDirectory)
      .map((e) => ({
        entrada: e,
        caminho: normalizarCaminhoRelativo(e.entryName),
      }));

    const candidatosMetadata = entradas
      .filter(
        (e) =>
          e.caminho === ARQUIVO_METADATA ||
          e.caminho.endsWith(`/${ARQUIVO_METADATA}`),
      )
      .sort((a, b) => a.caminho.length - b.caminho.length);

    if (candidatosMetadata.length === 0) {
      throw new BadRequestException(
        `Zip não contém ${ARQUIVO_METADATA} (saída de "npx expo export")`,
      );
    }

    const prefixo = candidatosMetadata[0].caminho.slice(
      0,
      -ARQUIVO_METADATA.length,
    ); // '' ou 'dist/'

    const dirRuntime = join(this.config.diretorio, runtimeVersion);
    const nome = await this.proximoNomeRelease(dirRuntime);
    const dirTemp = join(dirRuntime, `.tmp-${nome}`);
    const dirFinal = join(dirRuntime, nome);

    await fs.mkdir(dirTemp, { recursive: true });

    let tamanhoBytes = 0;
    try {
      for (const { entrada, caminho } of entradas) {
        if (!caminho.startsWith(prefixo)) continue;
        const relativo = caminho.slice(prefixo.length);
        if (!relativo || !caminhoRelativoSeguro(relativo)) {
          throw new BadRequestException(
            `Entrada inválida no zip: "${entrada.entryName}"`,
          );
        }
        const destino = resolve(dirTemp, relativo);
        if (!destino.startsWith(resolve(dirTemp) + sep)) {
          throw new BadRequestException(
            `Entrada inválida no zip: "${entrada.entryName}"`,
          );
        }
        const dados = entrada.getData();
        tamanhoBytes += dados.length;
        await fs.mkdir(dirname(destino), { recursive: true });
        await fs.writeFile(destino, dados);
      }

      const plataformas = await this.validarConteudoExport(
        dirTemp,
        runtimeVersion,
      );

      const meta: ReleaseMeta = {
        runtimeVersion,
        nome,
        criadoEm: nomeReleaseParaData(nome)!.toISOString(),
        plataformas,
        descricao: opts.descricao?.trim() || undefined,
        origem: opts.origem ?? 'upload',
        tamanhoBytes,
      };
      await fs.writeFile(
        join(dirTemp, ARQUIVO_RELEASE),
        JSON.stringify(meta, null, 2),
      );

      await fs.rename(dirTemp, dirFinal);
    } catch (err) {
      await fs.rm(dirTemp, { recursive: true, force: true });
      throw err;
    }

    this.logger.log(
      `Release publicado: ${runtimeVersion}/${nome} | plataformas=${(
        await this.carregarRelease(runtimeVersion, nome)
      )?.plataformas.join(
        ',',
      )} | ${(tamanhoBytes / 1024 / 1024).toFixed(2)} MB`,
    );

    return (await this.carregarRelease(runtimeVersion, nome))!;
  }

  /**
   * Rollback: copia um release antigo como um release NOVO (id e createdAt
   * novos). Necessário porque o expo-updates sempre lança o update de
   * commitTime mais recente já baixado — servir de novo o release antigo com o
   * createdAt original não faria os aparelhos voltarem.
   */
  async republicar(
    runtimeVersion: string,
    nome: string,
    descricao?: string,
  ): Promise<ReleaseInfo> {
    const origem = await this.obterRelease(runtimeVersion, nome);
    const dirRuntime = join(this.config.diretorio, origem.runtimeVersion);
    const novoNome = await this.proximoNomeRelease(dirRuntime);
    const dirTemp = join(dirRuntime, `.tmp-${novoNome}`);
    const dirFinal = join(dirRuntime, novoNome);

    try {
      await fs.cp(origem.caminho, dirTemp, { recursive: true });
      await fs.rm(join(dirTemp, MARCADOR_DESATIVADA), { force: true });

      const meta: ReleaseMeta = {
        runtimeVersion: origem.runtimeVersion,
        nome: novoNome,
        criadoEm: nomeReleaseParaData(novoNome)!.toISOString(),
        plataformas: origem.plataformas,
        descricao:
          descricao?.trim() ||
          `Rollback para ${origem.nome}${origem.descricao ? ` (${origem.descricao})` : ''}`,
        origem: `rollback:${origem.nome}`,
        tamanhoBytes: origem.tamanhoBytes,
      };
      await fs.writeFile(
        join(dirTemp, ARQUIVO_RELEASE),
        JSON.stringify(meta, null, 2),
      );
      await fs.rename(dirTemp, dirFinal);
    } catch (err) {
      await fs.rm(dirTemp, { recursive: true, force: true });
      throw err;
    }

    this.logger.warn(
      `Rollback: ${origem.runtimeVersion}/${origem.nome} republicado como ${novoNome}`,
    );
    return (await this.carregarRelease(origem.runtimeVersion, novoNome))!;
  }

  async desativar(runtimeVersion: string, nome: string): Promise<ReleaseInfo> {
    const release = await this.obterRelease(runtimeVersion, nome);
    await fs.writeFile(
      join(release.caminho, MARCADOR_DESATIVADA),
      new Date().toISOString(),
    );
    this.logger.warn(`Release desativado: ${runtimeVersion}/${nome}`);
    return { ...release, ativa: false };
  }

  async reativar(runtimeVersion: string, nome: string): Promise<ReleaseInfo> {
    const release = await this.obterRelease(runtimeVersion, nome);
    await fs.rm(join(release.caminho, MARCADOR_DESATIVADA), { force: true });
    this.logger.log(`Release reativado: ${runtimeVersion}/${nome}`);
    return { ...release, ativa: true };
  }

  async remover(runtimeVersion: string, nome: string): Promise<void> {
    const release = await this.obterRelease(runtimeVersion, nome);
    await fs.rm(release.caminho, { recursive: true, force: true });
    this.logger.warn(`Release removido do disco: ${runtimeVersion}/${nome}`);
  }

  // ───────────────────────────── internos ──────────────────────────────

  private validarSegmento(valor: string, campo: string): string {
    if (typeof valor !== 'string' || !SEGMENTO_SEGURO.test(valor)) {
      throw new BadRequestException(
        `${campo} inválido: use apenas letras, números, ".", "_" e "-"`,
      );
    }
    return valor;
  }

  /**
   * Nome estritamente maior que qualquer release já existente no runtime.
   * Garante que ordem lexicográfica == ordem de publicação == ordem de
   * `createdAt`, mesmo com duas publicações no mesmo milissegundo.
   */
  private async proximoNomeRelease(dirRuntime: string): Promise<string> {
    const existentes = (await this.lerDiretorio(dirRuntime))
      .filter((e) => e.isDirectory() && SEGMENTO_SEGURO.test(e.name))
      .map((e) => e.name)
      .sort();
    const ultimo = existentes.at(-1);

    let candidato = gerarNomeRelease();
    if (ultimo && candidato <= ultimo) {
      const dataUltimo = nomeReleaseParaData(ultimo);
      candidato = dataUltimo
        ? gerarNomeRelease(new Date(dataUltimo.getTime() + 1))
        : `${ultimo}-1`;
    }
    return candidato;
  }

  private async lerDiretorio(dir: string) {
    try {
      return await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async carregarRelease(
    runtimeVersion: string,
    nome: string,
  ): Promise<ReleaseInfo | null> {
    const caminho = join(this.config.diretorio, runtimeVersion, nome);

    let metadata: MetadataExport;
    try {
      metadata = JSON.parse(
        await fs.readFile(join(caminho, ARQUIVO_METADATA), 'utf8'),
      );
    } catch {
      return null; // pasta sem export válido — ignorada
    }

    let meta: Partial<ReleaseMeta> = {};
    try {
      meta = JSON.parse(
        await fs.readFile(join(caminho, ARQUIVO_RELEASE), 'utf8'),
      );
    } catch {
      // release copiado manualmente (rsync) sem release.json — usa fallbacks
    }

    const ativa = !(await this.existe(join(caminho, MARCADOR_DESATIVADA)));

    let criadoEm = meta.criadoEm;
    if (!criadoEm) {
      const stat = await fs.stat(caminho);
      criadoEm = stat.mtime.toISOString();
    }

    const plataformas =
      meta.plataformas && meta.plataformas.length
        ? meta.plataformas
        : PLATAFORMAS_EXPO.filter((p) => !!metadata.fileMetadata?.[p]);

    return {
      runtimeVersion,
      nome,
      caminho,
      ativa,
      criadoEm,
      plataformas,
      descricao: meta.descricao,
      origem: meta.origem,
      tamanhoBytes: meta.tamanhoBytes,
    };
  }

  /** Confere metadata.json, bundles e assets; devolve plataformas presentes. */
  private async validarConteudoExport(
    dir: string,
    runtimeVersion: string,
  ): Promise<PlataformaExpo[]> {
    let metadata: MetadataExport;
    try {
      metadata = JSON.parse(
        await fs.readFile(join(dir, ARQUIVO_METADATA), 'utf8'),
      );
    } catch (err) {
      throw new BadRequestException(
        `${ARQUIVO_METADATA} inválido: ${(err as Error).message}`,
      );
    }

    if (!metadata.fileMetadata || typeof metadata.fileMetadata !== 'object') {
      throw new BadRequestException(
        `${ARQUIVO_METADATA} sem "fileMetadata" — export incompleto`,
      );
    }

    // `expo export` no Windows grava caminhos com "\" no metadata.json —
    // normalizar antes de resolver no disco (a VPS é Linux).
    const plataformas: PlataformaExpo[] = [];
    for (const plataforma of PLATAFORMAS_EXPO) {
      const pm = metadata.fileMetadata[plataforma];
      if (!pm) continue;
      if (
        !pm.bundle ||
        !(await this.existe(join(dir, normalizarCaminhoRelativo(pm.bundle))))
      ) {
        throw new BadRequestException(
          `Bundle de ${plataforma} ausente no zip (${pm.bundle ?? 'sem caminho'})`,
        );
      }
      for (const asset of pm.assets ?? []) {
        if (
          !(await this.existe(join(dir, normalizarCaminhoRelativo(asset.path))))
        ) {
          throw new BadRequestException(
            `Asset de ${plataforma} ausente no zip: ${asset.path}`,
          );
        }
      }
      plataformas.push(plataforma);
    }

    if (plataformas.length === 0) {
      throw new BadRequestException(
        'Export não contém bundle de android nem de ios',
      );
    }

    // Se o expoConfig.json declara runtimeVersion como string, ela precisa bater
    try {
      const expoConfig = JSON.parse(
        await fs.readFile(join(dir, ARQUIVO_EXPO_CONFIG), 'utf8'),
      );
      const declarada = expoConfig?.runtimeVersion;
      if (typeof declarada === 'string' && declarada !== runtimeVersion) {
        throw new ConflictException(
          `runtimeVersion informada (${runtimeVersion}) difere da do expoConfig.json (${declarada})`,
        );
      }
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      // expoConfig.json ausente/ilegível: não é bloqueante
    }

    return plataformas;
  }

  private async existe(caminho: string): Promise<boolean> {
    try {
      await fs.access(caminho);
      return true;
    } catch {
      return false;
    }
  }
}
