import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AssociadoService } from 'src/associado/services/associado.service';
import { associadoPodeAcessarApp } from 'src/associado/helpers/acesso-app.helper';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hash'),
}));

const MSG_SEM_PERMISSAO = 'Associado sem permissão para acessar a aplicação';

describe('associadoPodeAcessarApp', () => {
  it.each(['ATIVO', 'INADIMPLENTE', 'INADIMPLENTE 20 DIAS'])(
    'associado %s acessa independente dos veículos',
    (situacao) => {
      expect(associadoPodeAcessarApp(situacao, [])).toBe(true);
      expect(associadoPodeAcessarApp(situacao, undefined)).toBe(true);
    },
  );

  it('PENDENTE DE PAGAMENTO com único veículo fora das situações permitidas é bloqueado', () => {
    expect(
      associadoPodeAcessarApp('PENDENTE DE PAGAMENTO', [
        { situacao: 'PENDENTE DE PAGAMENTO' },
      ]),
    ).toBe(false);
  });

  it.each(['ATIVO', 'INADIMPLENTE', 'INADIMPLENTE 20 DIAS'])(
    'PENDENTE DE PAGAMENTO com vários veículos e um deles %s acessa',
    (situacaoVeiculo) => {
      expect(
        associadoPodeAcessarApp('PENDENTE DE PAGAMENTO', [
          { situacao: 'INATIVO' },
          { situacao: situacaoVeiculo },
        ]),
      ).toBe(true);
    },
  );

  it('PENDENTE DE PAGAMENTO com único veículo em situação permitida acessa', () => {
    expect(
      associadoPodeAcessarApp('PENDENTE DE PAGAMENTO', [
        { descricao_situacao: ' inadimplente ' },
      ]),
    ).toBe(true);
  });

  it('PENDENTE DE PAGAMENTO com vários veículos, nenhum permitido, é bloqueado', () => {
    expect(
      associadoPodeAcessarApp('PENDENTE DE PAGAMENTO', [
        { situacao: 'INATIVO' },
        { situacao: 'PENDENTE DE PAGAMENTO' },
      ]),
    ).toBe(false);
  });

  it('PENDENTE DE PAGAMENTO sem veículos é bloqueado', () => {
    expect(associadoPodeAcessarApp('PENDENTE DE PAGAMENTO', [])).toBe(false);
    expect(associadoPodeAcessarApp('PENDENTE DE PAGAMENTO', null)).toBe(false);
  });

  it('demais situações do associado continuam bloqueadas mesmo com veículo ativo', () => {
    expect(associadoPodeAcessarApp('INATIVO', [{ situacao: 'ATIVO' }])).toBe(
      false,
    );
    expect(associadoPodeAcessarApp(undefined, [{ situacao: 'ATIVO' }])).toBe(
      false,
    );
  });
});

describe('AssociadoService — acesso por situação', () => {
  const cpf = '12345678901';
  let sgaAuth: { executeRequestWithAuth: jest.Mock };
  let authService: { register: jest.Mock; login: jest.Mock };
  let prisma: { user: { findFirst: jest.Mock } };
  let service: AssociadoService;

  /** Roteia as chamadas ao SGA pela URL. */
  const mockSga = (rotas: {
    situacao?: { status: number; data: unknown };
    associado?: { status: number; data: unknown };
  }) => {
    sgaAuth.executeRequestWithAuth.mockImplementation(
      (_base: string, config: { url: string }) => {
        if (config.url.includes('/buscar/situacao-associado/')) {
          return Promise.resolve(rotas.situacao);
        }
        return Promise.resolve(rotas.associado);
      },
    );
  };

  const chamadasBuscarAssociado = () =>
    sgaAuth.executeRequestWithAuth.mock.calls.filter(
      ([, config]: [string, { url: string }]) =>
        config.url.includes('/associado/buscar/'),
    ).length;

  beforeEach(() => {
    sgaAuth = { executeRequestWithAuth: jest.fn() };
    authService = {
      register: jest.fn().mockResolvedValue({ id: 1 }),
      login: jest.fn().mockResolvedValue({ access_token: 'jwt' }),
    };
    prisma = { user: { findFirst: jest.fn() } };
    service = new AssociadoService(
      prisma as never,
      authService as never,
      {} as never,
      sgaAuth as never,
    );
  });

  describe('verificarSituacao', () => {
    beforeEach(() => {
      // Base já conhecida no banco: detectBaseOrigin não consulta o SGA.
      prisma.user.findFirst.mockResolvedValue({ baseOrigin: 'MAIS_PRIME' });
    });

    it('associado ATIVO mantém a resposta e não consulta veículos', async () => {
      mockSga({ situacao: { status: 200, data: { descricao: 'ATIVO' } } });

      await expect(service.verificarSituacao(cpf)).resolves.toEqual({
        situacao: 'ATIVO',
        mensagem: 'Situação verificada com sucesso',
      });
      expect(chamadasBuscarAssociado()).toBe(0);
    });

    it('PENDENTE DE PAGAMENTO com único veículo não permitido → 403 atual', async () => {
      mockSga({
        situacao: { status: 200, data: { descricao: 'PENDENTE DE PAGAMENTO' } },
        associado: {
          status: 200,
          data: { veiculos: [{ situacao: 'PENDENTE DE PAGAMENTO' }] },
        },
      });

      const erro = await service.verificarSituacao(cpf).catch((e) => e);
      expect(erro).toBeInstanceOf(ForbiddenException);
      expect(erro.message).toBe(MSG_SEM_PERMISSAO);
    });

    it('PENDENTE DE PAGAMENTO com vários veículos e um INADIMPLENTE → acessa', async () => {
      mockSga({
        situacao: { status: 200, data: { descricao: 'PENDENTE DE PAGAMENTO' } },
        associado: {
          status: 200,
          data: {
            veiculos: [
              { situacao: 'PENDENTE DE PAGAMENTO' },
              { situacao: 'INADIMPLENTE' },
            ],
          },
        },
      });

      await expect(service.verificarSituacao(cpf)).resolves.toEqual({
        situacao: 'PENDENTE DE PAGAMENTO',
        mensagem: 'Situação verificada com sucesso',
      });
    });

    it('PENDENTE DE PAGAMENTO sem lista de veículos → 403 atual', async () => {
      mockSga({
        situacao: { status: 200, data: { descricao: 'PENDENTE DE PAGAMENTO' } },
        associado: { status: 200, data: {} },
      });

      await expect(service.verificarSituacao(cpf)).rejects.toThrow(
        MSG_SEM_PERMISSAO,
      );
    });

    it('PENDENTE DE PAGAMENTO com SGA bloqueado na busca de veículos → 403 de indisponibilidade', async () => {
      mockSga({
        situacao: { status: 200, data: { descricao: 'PENDENTE DE PAGAMENTO' } },
        associado: { status: 401, data: {} },
      });

      const erro = await service.verificarSituacao(cpf).catch((e) => e);
      expect(erro).toBeInstanceOf(ForbiddenException);
      expect(erro.message).toContain('indisponibilidade temporária');
    });

    it('outras situações continuam bloqueadas sem consultar veículos', async () => {
      mockSga({ situacao: { status: 200, data: { descricao: 'INATIVO' } } });

      await expect(service.verificarSituacao(cpf)).rejects.toThrow(
        MSG_SEM_PERMISSAO,
      );
      expect(chamadasBuscarAssociado()).toBe(0);
    });
  });

  describe('primeiroAcesso', () => {
    const cadastro = {
      cpf,
      nome: 'Associado Teste',
      email: 'a@x.com',
      descricao_situacao: 'PENDENTE DE PAGAMENTO',
    };

    beforeEach(() => {
      // Usuário ainda não existe; a base é detectada pelo SGA (HTTP 200).
      prisma.user.findFirst.mockResolvedValue(null);
    });

    it('PENDENTE DE PAGAMENTO com veículo ATIVO entre vários → cadastra', async () => {
      mockSga({
        associado: {
          status: 200,
          data: {
            ...cadastro,
            veiculos: [{ situacao: 'CANCELADO' }, { situacao: 'ATIVO' }],
          },
        },
      });

      await expect(service.primeiroAcesso(cpf)).resolves.toEqual({
        message: 'Associado cadastrado com sucesso',
        access_token: 'jwt',
        primeiroLogin: true,
      });
      expect(authService.register).toHaveBeenCalled();
    });

    it('PENDENTE DE PAGAMENTO com único veículo não permitido → 400 atual', async () => {
      mockSga({
        associado: {
          status: 200,
          data: { ...cadastro, veiculos: [{ situacao: 'CANCELADO' }] },
        },
      });

      const erro = await service.primeiroAcesso(cpf).catch((e) => e);
      expect(erro).toBeInstanceOf(BadRequestException);
      expect(erro.message).toBe('Cpf de associado inválido para cadastro');
      expect(authService.register).not.toHaveBeenCalled();
    });
  });
});
