import type { MensagemPush } from 'src/integrations/expo/push.gateway';

/** Carga livre que vai em `data` do push e na caixa de entrada. */
export type DadosDoPush = Record<string, unknown>;

/**
 * Mensagem no formato que o app espera. `_contentAvailable` e
 * `mutableContent` acordam o app no iOS em segundo plano; a porta
 * `MensagemPush` ainda não declara os dois, mas o adaptador repassa o objeto
 * inteiro ao provedor.
 */
export interface MensagemPushDoApp extends MensagemPush {
  _contentAvailable: true;
  mutableContent: true;
}

/** Monta o push. O `channelId` precisa bater com o canal criado pelo app. */
export function montarMensagemPush(
  token: string,
  titulo: string,
  corpo: string,
  dados: DadosDoPush,
): MensagemPushDoApp {
  return {
    to: token,
    title: titulo,
    body: corpo,
    data: dados,
    sound: 'default',
    priority: 'high',
    channelId: 'alerts_v2',
    _contentAvailable: true,
    mutableContent: true,
  };
}

/** Token para log: nunca o valor inteiro. */
export function mascararTokenPush(token?: string | null): string {
  if (!token) return 'ausente';
  if (token.length <= 16) return token;
  return `${token.slice(0, 12)}...${token.slice(-4)}`;
}
