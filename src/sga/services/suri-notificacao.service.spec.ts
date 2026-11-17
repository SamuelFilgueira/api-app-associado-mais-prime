import {
  mascararTelefone,
  SuriNotificacaoService,
} from 'src/sga/services/suri-notificacao.service';

const axiosPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...args: unknown[]) => axiosPost(...args) },
}));

describe('SuriNotificacaoService', () => {
  const envOriginal = { ...process.env };
  let service: SuriNotificacaoService;

  beforeEach(() => {
    process.env.suri_baseUrl = 'https://suri.example/api/messages/send';
    process.env.token_suri = 'token';
    process.env.channelId = 'canal';
    process.env.sendTo = 'dept';
    axiosPost.mockReset();
    service = new SuriNotificacaoService();
  });

  afterEach(() => {
    process.env = { ...envOriginal };
  });

  const enviar = () =>
    service.enviarTemplate({
      nome: 'FULANO DE TAL',
      telefoneCelular: '(31) 98888-7777',
      templateId: 'tpl-1',
      parametrosExtras: ['https://boleto/link'],
      contexto: 'boleto-reativacao',
    });

  it('payload inalterado: DDI 55, primeiro nome formatado e parâmetros extras', async () => {
    axiosPost.mockResolvedValue({ status: 200, data: { ok: true } });

    await expect(enviar()).resolves.toBeUndefined();

    const [url, body, config] = axiosPost.mock.calls[0];
    expect(url).toBe('https://suri.example/api/messages/send');
    expect(body).toEqual({
      user: {
        name: 'FULANO DE TAL',
        phone: '5531988887777',
        email: null,
        gender: 0,
        channelId: 'canal',
        channelType: 1,
        defaultDepartmentId: null,
      },
      message: {
        templateId: 'tpl-1',
        BodyParameters: ['Fulano', 'https://boleto/link'],
      },
      responseAction: { type: 1, sendTo: 'dept' },
    });
    expect(config.headers.Authorization).toBe('Bearer token');
  });

  it('erro HTTP da Suri não lança (comportamento original)', async () => {
    axiosPost.mockResolvedValue({
      status: 400,
      data: { error: 'Template not found' },
    });
    await expect(enviar()).resolves.toBeUndefined();
  });

  it('falha de rede continua propagando para o chamador', async () => {
    axiosPost.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(enviar()).rejects.toThrow('ECONNREFUSED');
  });
});

describe('mascararTelefone', () => {
  it('mantém DDI/DDD e os 4 finais', () => {
    expect(mascararTelefone('5531988887777')).toBe('55319****7777');
    expect(mascararTelefone('')).toBe('(vazio)');
  });
});
