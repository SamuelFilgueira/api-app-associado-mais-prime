import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'fs';
import { join } from 'path';
import { SGA_BASE_URL } from 'src/integrations/hinova/hinova.constants';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import {
  FotoParaEnvio,
  ResultadoEnvioFoto,
  RetornoHinovaFoto,
  aplicarRetorno,
  descreverFalhaDaChamada,
  descreverRespostaInvalida,
  mensagemDoErro,
  resultadosIniciais,
  resumirResposta,
} from 'src/reinspection/domain/hinova-envio';

/** Timeout da chamada `/veiculo/foto/cadastrar` (payload grande, Hinova lenta). */
const HINOVA_FOTO_TIMEOUT_MS = 60_000;

export interface RevistoriaParaEnvio {
  id: number;
  codigoVeiculo: number | null;
}

export interface RespostaDaChamada {
  httpStatus: number | null;
  responseBody?: Prisma.InputJsonValue;
  errorMessage: string | null;
}

type FotoLida = FotoParaEnvio & { binario: string };

/**
 * Um lote de fotos para a Hinova: lê os arquivos locais, posta em
 * `POST /veiculo/foto/cadastrar` e devolve o resultado POR FOTO. Não grava
 * nada e não lança por falha da Hinova — quem chama registra a tentativa.
 */
@Injectable()
export class ReinspectionHinovaLoteService {
  constructor(private readonly sgaAuthService: SgaAuthService) {}

  async postar(
    revistoria: RevistoriaParaEnvio,
    baseOrigin: string,
    fotos: FotoParaEnvio[],
  ): Promise<{ resultados: ResultadoEnvioFoto[]; chamada: RespostaDaChamada }> {
    const resultados = resultadosIniciais(fotos);

    // Uma foto sem arquivo não derruba as demais: fica com o erro dela e o
    // lote segue.
    const lidas: FotoLida[] = [];
    for (const foto of fotos) {
      const leitura = await this.lerBase64(foto.url);
      if (leitura.ok) lidas.push({ ...foto, binario: leitura.binario });
      else resultados.get(foto.id)!.erro = leitura.erro;
    }

    const chamada: RespostaDaChamada =
      lidas.length === 0
        ? {
            httpStatus: null,
            errorMessage: 'Nenhuma foto pôde ser lida do armazenamento local',
          }
        : await this.chamarHinova(revistoria, baseOrigin, lidas, resultados);

    return { resultados: Array.from(resultados.values()), chamada };
  }

  /**
   * Posta o lote e distribui o resultado por foto. Falha da chamada vira
   * `errorMessage` + erro em cada foto do lote (a tentativa é registrada
   * como FALHA); nenhuma foto é marcada como enviada sem confirmação.
   */
  private async chamarHinova(
    revistoria: RevistoriaParaEnvio,
    baseOrigin: string,
    lidas: FotoLida[],
    resultados: Map<number, ResultadoEnvioFoto>,
  ): Promise<RespostaDaChamada> {
    const payload: Record<string, unknown> = {
      foto: lidas.map((foto) => ({
        nome_arquivo: foto.nomeArquivo,
        ...(foto.codigoTipo != null ? { codigo_tipo: foto.codigoTipo } : {}),
        binario: foto.binario,
      })),
    };
    if (revistoria.codigoVeiculo != null) {
      payload.codigo_veiculo = revistoria.codigoVeiculo;
    }

    const falharLote = (errorMessage: string) => {
      for (const foto of lidas) resultados.get(foto.id)!.erro = errorMessage;
      return errorMessage;
    };

    try {
      const response =
        await this.sgaAuthService.executeRequestWithAuth<unknown>(baseOrigin, {
          method: 'POST',
          url: `${SGA_BASE_URL}/veiculo/foto/cadastrar`,
          data: payload,
          headers: { 'Content-Type': 'application/json' },
          timeout: HINOVA_FOTO_TIMEOUT_MS,
          validateStatus: () => true,
        });

      const resposta: RespostaDaChamada = {
        httpStatus: response.status,
        responseBody: resumirResposta(response.data),
        errorMessage: null,
      };
      if (response.status >= 400 || !Array.isArray(response.data)) {
        resposta.errorMessage = falharLote(
          descreverRespostaInvalida(response.status, response.data),
        );
      } else {
        aplicarRetorno(lidas, response.data as RetornoHinovaFoto[], resultados);
      }
      return resposta;
    } catch (erro) {
      // Tratado, não engolido: a tentativa é gravada como FALHA com este
      // texto e o resultado devolvido ao chamador diz que falhou.
      return {
        httpStatus: null,
        errorMessage: falharLote(descreverFalhaDaChamada(erro)),
      };
    }
  }

  private async lerBase64(
    photoUrl: string | null,
  ): Promise<{ ok: true; binario: string } | { ok: false; erro: string }> {
    if (!photoUrl) return { ok: false, erro: 'Foto sem URL local' };
    try {
      const buffer = await fs.readFile(join(process.cwd(), photoUrl));
      return { ok: true, binario: buffer.toString('base64') };
    } catch (erro) {
      return {
        ok: false,
        erro: `Falha ao ler arquivo local ${photoUrl}: ${mensagemDoErro(erro)}`,
      };
    }
  }
}
