import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'src/database/prisma.service';
import { SituacaoCadastroNotificationData } from 'src/notifications/dto/send-situacao-cadastro-notification.dto';

export interface SituacaoCadastroResultado {
  sentCount: number;
  skippedCount: number;
  resumo: {
    totalLinhasPlanilha: number;
    cpfsValidos: number;
    cpfsInvalidos: string[];
    cpfsDuplicadosRemovidos: number;
    cpfsNaoEncontrados: string[];
    cpfsInativos: string[];
    cpfsSemToken: string[];
    cpfsComFalhaEnvio: string[];
  };
}

interface ExtracaoPlanilha {
  cpfs: string[];
  cpfsInvalidos: string[];
  totalLinhas: number;
  duplicadosRemovidos: number;
}

/**
 * Envio de notificação push em massa para uma lista de CPFs vinda de
 * planilha Excel (mudança de situação no cadastro — ex.: Ativo -> Inadimplente).
 * Segue o mesmo fluxo de envio da rota de marketing, mas segmentado por CPF
 * e sem filtro de opt-in de marketing (notificação de cadastro, não promocional).
 */
@Injectable()
export class SituacaoCadastroNotificationService {
  private readonly logger = new Logger(
    SituacaoCadastroNotificationService.name,
  );
  private expo = new Expo();

  private static readonly MAX_CPFS = 10000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Valida os dígitos verificadores do CPF (11 dígitos, já normalizado).
   */
  private validarDigitosCpf(cpf: string): boolean {
    if (!/^\d{11}$/.test(cpf)) return false;
    if (/^(\d)\1{10}$/.test(cpf)) return false;

    const calcularDigito = (tamanho: number): number => {
      let soma = 0;
      for (let i = 0; i < tamanho; i++) {
        soma += parseInt(cpf[i], 10) * (tamanho + 1 - i);
      }
      const resto = (soma * 10) % 11;
      return resto === 10 ? 0 : resto;
    };

    return (
      calcularDigito(9) === parseInt(cpf[9], 10) &&
      calcularDigito(10) === parseInt(cpf[10], 10)
    );
  }

  /**
   * Normaliza o valor de uma célula para CPF: remove máscara e repõe zeros à
   * esquerda perdidos quando a célula do Excel é numérica.
   */
  private normalizarCpf(valorBruto: string): string | null {
    const digitos = valorBruto.replace(/\D/g, '');
    if (!digitos) return null;
    if (digitos.length > 11) return null;
    return digitos.padStart(11, '0');
  }

  /**
   * Extrai os CPFs da primeira aba da planilha. Se a primeira linha tiver um
   * cabeçalho contendo "cpf", usa essa coluna; caso contrário usa a coluna A.
   */
  private async extrairCpfsDaPlanilha(
    buffer: Buffer,
  ): Promise<ExtracaoPlanilha> {
    const workbook = new ExcelJS.Workbook();

    try {
      // Cast necessário: o tipo Buffer do exceljs conflita com o Buffer do Node
      await workbook.xlsx.load(buffer as any);
    } catch {
      throw new BadRequestException(
        'Arquivo inválido. Envie uma planilha Excel no formato .xlsx',
      );
    }

    const worksheet = workbook.worksheets[0];
    if (!worksheet || worksheet.rowCount === 0) {
      throw new BadRequestException('A planilha está vazia');
    }

    // Detecta a coluna de CPF pelo cabeçalho da primeira linha
    let colunaCpf = 1;
    let linhaInicial = 1;
    const primeiraLinha = worksheet.getRow(1);
    primeiraLinha.eachCell((cell, colNumber) => {
      if (/cpf/i.test(cell.text ?? '')) {
        colunaCpf = colNumber;
        linhaInicial = 2;
      }
    });

    const cpfsUnicos = new Set<string>();
    const cpfsInvalidos: string[] = [];
    let totalLinhas = 0;
    let duplicadosRemovidos = 0;

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber < linhaInicial) return;

      const valorBruto = String(row.getCell(colunaCpf).text ?? '').trim();
      if (!valorBruto) return;

      totalLinhas++;

      const cpf = this.normalizarCpf(valorBruto);
      if (!cpf || !this.validarDigitosCpf(cpf)) {
        cpfsInvalidos.push(valorBruto);
        return;
      }

      if (cpfsUnicos.has(cpf)) {
        duplicadosRemovidos++;
        return;
      }

      cpfsUnicos.add(cpf);
    });

    if (cpfsUnicos.size === 0) {
      throw new BadRequestException(
        'Nenhum CPF válido encontrado na planilha. Verifique a coluna de CPFs e o formato do arquivo.',
      );
    }

    if (cpfsUnicos.size > SituacaoCadastroNotificationService.MAX_CPFS) {
      throw new BadRequestException(
        `A planilha excede o limite de ${SituacaoCadastroNotificationService.MAX_CPFS} CPFs por envio`,
      );
    }

    return {
      cpfs: Array.from(cpfsUnicos),
      cpfsInvalidos,
      totalLinhas,
      duplicadosRemovidos,
    };
  }

  /**
   * Corrige texto que chegou com mojibake (UTF-8 lido como latin1/cp1252 —
   * ex.: "AtualizaÃ§Ã£o" em vez de "Atualização"). Texto já correto passa
   * intocado; a correção só é aplicada quando o padrão típico é detectado
   * e a re-decodificação produz UTF-8 válido.
   */
  corrigirTextoUtf8(texto: string): string {
    if (!texto || !/[\u00C2\u00C3][\u0080-\u00BF]/.test(texto)) {
      return texto;
    }

    // Caracteres do cp1252 que ocupam a faixa 0x80–0x9F (ex.: €, ", –)
    const cp1252: Record<string, number> = {
      '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84,
      '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88,
      '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
      'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93,
      '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
      '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
      'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
    };

    const bytes: number[] = [];
    for (const char of texto) {
      const code = char.codePointAt(0) as number;
      if (code <= 0xff) {
        bytes.push(code);
      } else if (cp1252[char] !== undefined) {
        bytes.push(cp1252[char]);
      } else {
        // Contém caractere fora do padrão de mojibake — não arriscar corrigir
        return texto;
      }
    }

    const decodificado = Buffer.from(bytes).toString('utf8');
    // Se a re-decodificação gerou caractere inválido, mantém o original
    return decodificado.includes('�') ? texto : decodificado;
  }

  /**
   * Parseia o campo `data` (string JSON do multipart) no mesmo formato
   * aceito pela rota de marketing. Sem `data`, o padrão leva o associado
   * à tela de boletos do app (financeiro).
   */
  parseDataPayload(raw?: string): SituacaoCadastroNotificationData {
    if (!raw || !raw.trim()) {
      return { type: 'internal_route', screen: 'financeiro' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('O campo "data" não é um JSON válido');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BadRequestException('O campo "data" deve ser um objeto JSON');
    }

    const data = parsed as SituacaoCadastroNotificationData;
    if (!data.type) {
      data.type = data.screen ? 'internal_route' : 'situacao_cadastro';
    }

    // Corrige mojibake também nos valores de texto do payload extra
    for (const chave of Object.keys(data)) {
      if (typeof data[chave] === 'string') {
        data[chave] = this.corrigirTextoUtf8(data[chave]);
      }
    }

    return data;
  }

  private buildExpoMessage(
    expoPushToken: string,
    title: string,
    body: string,
    data: SituacaoCadastroNotificationData,
  ): ExpoPushMessage {
    return {
      to: expoPushToken,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
      channelId: 'alerts_v2',
      _contentAvailable: true,
      mutableContent: true,
    };
  }

  /**
   * Fluxo principal: extrai CPFs da planilha, resolve os usuários elegíveis,
   * envia os pushes em chunks e persiste as notificações enviadas.
   */
  async enviarPorPlanilha(
    fileBuffer: Buffer,
    title: string,
    body: string,
    data: SituacaoCadastroNotificationData,
  ): Promise<SituacaoCadastroResultado> {
    const extracao = await this.extrairCpfsDaPlanilha(fileBuffer);

    this.logger.log(
      `[SITUACAO-CADASTRO] Planilha processada: ${extracao.totalLinhas} linhas, ` +
        `${extracao.cpfs.length} CPFs únicos válidos, ${extracao.cpfsInvalidos.length} inválidos, ` +
        `${extracao.duplicadosRemovidos} duplicados removidos`,
    );

    const usuarios = await this.prisma.user.findMany({
      where: { cpf: { in: extracao.cpfs } },
      select: {
        id: true,
        cpf: true,
        isActive: true,
        expoPushToken: true,
      },
    });

    const usuariosPorCpf = new Map(usuarios.map((u) => [u.cpf, u]));

    const cpfsNaoEncontrados: string[] = [];
    const cpfsInativos: string[] = [];
    const cpfsSemToken: string[] = [];
    const destinatarios: Array<{
      id: number;
      cpf: string;
      expoPushToken: string;
    }> = [];

    for (const cpf of extracao.cpfs) {
      const usuario = usuariosPorCpf.get(cpf);

      if (!usuario) {
        cpfsNaoEncontrados.push(cpf);
        continue;
      }

      if (!usuario.isActive) {
        cpfsInativos.push(cpf);
        continue;
      }

      if (
        !usuario.expoPushToken ||
        !Expo.isExpoPushToken(usuario.expoPushToken)
      ) {
        cpfsSemToken.push(cpf);
        continue;
      }

      destinatarios.push({
        id: usuario.id,
        cpf: usuario.cpf,
        expoPushToken: usuario.expoPushToken,
      });
    }

    const cpfsComFalhaEnvio: string[] = [];
    const enviados: Array<{ id: number; expoPushToken: string }> = [];

    if (destinatarios.length > 0) {
      const messages = destinatarios.map((destinatario) =>
        this.buildExpoMessage(destinatario.expoPushToken, title, body, data),
      );

      const chunks = this.expo.chunkPushNotifications(messages);
      let offset = 0;

      for (const chunk of chunks) {
        try {
          const tickets = await this.expo.sendPushNotificationsAsync(chunk);

          tickets.forEach((ticket, index) => {
            const destinatario = destinatarios[offset + index];
            if (ticket.status === 'ok') {
              enviados.push({
                id: destinatario.id,
                expoPushToken: destinatario.expoPushToken,
              });
            } else {
              cpfsComFalhaEnvio.push(destinatario.cpf);
              this.logger.warn(
                `[SITUACAO-CADASTRO] Ticket com erro para user ${destinatario.id}: ${ticket.message ?? 'erro desconhecido'}`,
              );
            }
          });
        } catch (error) {
          chunk.forEach((_, index) => {
            cpfsComFalhaEnvio.push(destinatarios[offset + index].cpf);
          });
          this.logger.error(
            `[SITUACAO-CADASTRO] Erro ao enviar chunk: ${error.message}`,
          );
        }

        offset += chunk.length;
      }

      // Persiste apenas as notificações realmente enviadas (mesmo padrão do marketing)
      if (enviados.length > 0) {
        try {
          await this.prisma.notification.createMany({
            data: enviados.map((destinatario) => ({
              userId: destinatario.id,
              expoPushToken: destinatario.expoPushToken,
              title,
              body,
              data: data as any,
              sentAt: new Date(),
            })),
          });
        } catch (error) {
          this.logger.error(
            `[SITUACAO-CADASTRO] Erro ao salvar notificações no histórico: ${error.message}`,
          );
        }
      }
    } else {
      this.logger.warn(
        '[SITUACAO-CADASTRO] Nenhum destinatário elegível para envio',
      );
    }

    const skippedCount =
      cpfsNaoEncontrados.length +
      cpfsInativos.length +
      cpfsSemToken.length +
      cpfsComFalhaEnvio.length;

    this.logger.log(
      `[SITUACAO-CADASTRO] Envio concluído: ${enviados.length} enviadas, ${skippedCount} ignoradas`,
    );

    return {
      sentCount: enviados.length,
      skippedCount,
      resumo: {
        totalLinhasPlanilha: extracao.totalLinhas,
        cpfsValidos: extracao.cpfs.length,
        cpfsInvalidos: extracao.cpfsInvalidos,
        cpfsDuplicadosRemovidos: extracao.duplicadosRemovidos,
        cpfsNaoEncontrados,
        cpfsInativos,
        cpfsSemToken,
        cpfsComFalhaEnvio,
      },
    };
  }
}
