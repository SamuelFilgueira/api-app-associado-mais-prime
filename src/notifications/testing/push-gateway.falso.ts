import {
  MensagemPush,
  PushGateway,
  ReciboPush,
  ResultadoPush,
} from 'src/integrations/expo/push.gateway';

/**
 * Provedor de push falso para testes: guarda o que recebeu e responde o que
 * o teste mandar. O padrão aceita tudo, com um ticket por token.
 */
export class PushGatewayFalso extends PushGateway {
  /** Mensagens de cada chamada a `enviar`, na ordem. */
  readonly chamadas: MensagemPush[][] = [];
  /** Ids consultados em cada chamada a `consultarRecibos`. */
  readonly consultas: string[][] = [];
  private readonly aceitos = new Map<string, number>();
  /** Tempo que cada chamada a `enviar` leva (simula a latência do provedor). */
  atrasoMs = 0;

  /** Resposta de cada chamada (`chamada` começa em 0). */
  responder: (mensagens: MensagemPush[], chamada: number) => ResultadoPush[] =
    PushGatewayFalso.aceitarTudo;

  /** Recibos devolvidos; o padrão confirma a entrega de todos. */
  recibos: (ticketIds: string[]) => Record<string, ReciboPush> = (ids) =>
    Object.fromEntries(ids.map((id) => [id, { status: 'ok' } as ReciboPush]));

  static aceitarTudo(this: void, mensagens: MensagemPush[]): ResultadoPush[] {
    return mensagens.map((m) => ({ status: 'ok', ticketId: `ticket-${m.to}` }));
  }

  /** A chamada não chegou a uma resposta (rede, timeout, 5xx). */
  static semResposta(this: void, mensagens: MensagemPush[]): ResultadoPush[] {
    return mensagens.map(() => ({
      status: 'falha_transporte',
      mensagem: 'socket hang up',
    }));
  }

  tokenValido(token: unknown): token is string {
    return (
      typeof token === 'string' &&
      /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token)
    );
  }

  async enviar(mensagens: MensagemPush[]): Promise<ResultadoPush[]> {
    const chamada = this.chamadas.length;
    this.chamadas.push(mensagens);
    if (this.atrasoMs > 0) {
      await new Promise((r) => setTimeout(r, this.atrasoMs));
    }
    const resultados = this.responder(mensagens, chamada);
    resultados.forEach((resultado, i) => {
      if (resultado.status !== 'ok') return;
      const token = mensagens[i].to;
      this.aceitos.set(token, (this.aceitos.get(token) ?? 0) + 1);
    });
    return resultados;
  }

  consultarRecibos(ticketIds: string[]): Promise<Record<string, ReciboPush>> {
    this.consultas.push(ticketIds);
    return Promise.resolve(this.recibos(ticketIds));
  }

  /** Esquece o que recebeu e volta às respostas padrão (entre casos de teste). */
  limpar(): void {
    this.chamadas.length = 0;
    this.consultas.length = 0;
    this.aceitos.clear();
    this.atrasoMs = 0;
    this.responder = PushGatewayFalso.aceitarTudo;
    this.recibos = (ids) =>
      Object.fromEntries(ids.map((id) => [id, { status: 'ok' } as ReciboPush]));
  }

  /** Quantos pushes ACEITOS cada token recebeu. */
  aceitosPorToken(): Map<string, number> {
    return new Map(this.aceitos);
  }

  /** Total de mensagens mandadas ao provedor, aceitas ou não. */
  totalDeMensagens(): number {
    return this.chamadas.reduce((soma, lote) => soma + lote.length, 0);
  }
}
