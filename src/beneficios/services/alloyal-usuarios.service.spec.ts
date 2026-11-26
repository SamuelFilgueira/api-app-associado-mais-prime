import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  AlloyalUsuariosService,
  SolicitanteAlloyal,
} from 'src/beneficios/services/alloyal-usuarios.service';
import { AlloyalGateway } from 'src/integrations/alloyal/alloyal.gateway';
import { DomainError, IntegrationError } from 'src/shared/erros/erros';

describe('AlloyalUsuariosService', () => {
  const CPF = '11122233344';
  const OUTRO_CPF = '55566677788';
  const associado: SolicitanteAlloyal = {
    usuario: { userId: 7, cpf: CPF, role: 'USER', baseOrigin: 'MAIS_PRIME' },
    base: 'MAIS_PRIME',
  };
  const admin: SolicitanteAlloyal = {
    usuario: { userId: 1, role: 'ADMIN' },
    base: 'MAIS_PRIME_RS',
  };
  const dados = {
    name: 'Dono',
    cpf: CPF,
    email: 'dono@teste.local',
    password: 'x',
  };

  let alloyal: Record<
    'buscarUsuariosPorCpf' | 'criarUsuario' | 'atualizarUsuario',
    jest.Mock
  >;
  let servico: AlloyalUsuariosService;

  beforeEach(() => {
    alloyal = {
      buscarUsuariosPorCpf: jest
        .fn()
        .mockResolvedValue([{ id: 900, cpf: CPF }]),
      criarUsuario: jest
        .fn()
        .mockResolvedValue({ id: 900, cpf: CPF, active: true }),
      atualizarUsuario: jest.fn().mockResolvedValue({ id: 900, cpf: CPF }),
    };
    servico = new AlloyalUsuariosService(alloyal as unknown as AlloyalGateway);
  });

  const nenhumaChamada = () => {
    expect(alloyal.buscarUsuariosPorCpf).not.toHaveBeenCalled();
    expect(alloyal.criarUsuario).not.toHaveBeenCalled();
    expect(alloyal.atualizarUsuario).not.toHaveBeenCalled();
  };

  describe('buscarPorCpf', () => {
    it('o próprio CPF (com ou sem máscara) → lista da Alloyal, na base do token', async () => {
      await expect(servico.buscarPorCpf(associado, CPF)).resolves.toEqual([
        { id: 900, cpf: CPF },
      ]);
      await servico.buscarPorCpf(associado, '111.222.333-44');

      expect(alloyal.buscarUsuariosPorCpf.mock.calls).toEqual([
        ['MAIS_PRIME', CPF],
        ['MAIS_PRIME', '111.222.333-44'],
      ]);
    });

    it('CPF de terceiro → 403, sem chamar a Alloyal', async () => {
      await expect(
        servico.buscarPorCpf(associado, OUTRO_CPF),
      ).rejects.toBeInstanceOf(ForbiddenException);
      nenhumaChamada();
    });

    it('resposta que não é lista → ninguém', async () => {
      alloyal.buscarUsuariosPorCpf.mockResolvedValue({ users: [] });

      await expect(servico.buscarPorCpf(associado, CPF)).resolves.toEqual([]);
    });

    it('ADMIN consulta qualquer CPF, na base do próprio token', async () => {
      await servico.buscarPorCpf(admin, OUTRO_CPF);

      expect(alloyal.buscarUsuariosPorCpf).toHaveBeenCalledWith(
        'MAIS_PRIME_RS',
        OUTRO_CPF,
      );
    });
  });

  describe('ordem das checagens (contrato): posse, depois base, depois Alloyal', () => {
    const semBase: SolicitanteAlloyal = { usuario: associado.usuario };

    it('CPF de terceiro e token sem base → 403 (a posse vem antes)', async () => {
      await expect(
        servico.buscarPorCpf(semBase, OUTRO_CPF),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        servico.criar(semBase, { ...dados, cpf: OUTRO_CPF }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      nenhumaChamada();
    });

    it('o próprio CPF e token sem base → falha de base (não 403), sem chamar a Alloyal', async () => {
      await expect(servico.buscarPorCpf(semBase, CPF)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(servico.criar(semBase, dados)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(
        servico.atualizar(semBase, CPF, { password: 'nova' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // Id de terceiro: a consulta de posse já exige a base.
      await expect(
        servico.atualizar(semBase, '901', { password: 'nova' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      nenhumaChamada();
    });

    it('base que não é deste deploy → erro de base, sem chamar a Alloyal', async () => {
      await expect(
        servico.buscarPorCpf({ ...associado, base: 'OUTRA_EMPRESA' }, CPF),
      ).rejects.toMatchObject({ code: 'BASE_NAO_RESOLVIDA' });
      nenhumaChamada();
    });

    it('sem usuário autenticado → 403', async () => {
      await expect(
        servico.buscarPorCpf({ base: 'MAIS_PRIME' }, CPF),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        servico.atualizar({ base: 'MAIS_PRIME' }, CPF, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      nenhumaChamada();
    });
  });

  describe('criar', () => {
    it('cadastra com a tag do app e devolve o usuário', async () => {
      await expect(servico.criar(associado, dados)).resolves.toEqual({
        id: 900,
        cpf: CPF,
        active: true,
      });

      expect(alloyal.criarUsuario).toHaveBeenCalledWith('MAIS_PRIME', {
        ...dados,
        user_tags: 'APP-ASSOCIADO',
      });
      expect(alloyal.atualizarUsuario).not.toHaveBeenCalled();
    });

    it('usuário que já existia desativado → reativa com os dados novos, na mesma base', async () => {
      alloyal.criarUsuario.mockResolvedValue({ id: 9, active: false });
      alloyal.atualizarUsuario.mockResolvedValue({ id: 9, active: true });

      await expect(servico.criar(associado, dados)).resolves.toEqual({
        id: 9,
        active: true,
      });

      expect(alloyal.atualizarUsuario).toHaveBeenCalledWith('MAIS_PRIME', CPF, {
        name: 'Dono',
        email: 'dono@teste.local',
        password: 'x',
        active: true,
        user_tags: ['APP-ASSOCIADO'],
      });
    });

    it('falha na reativação propaga (não devolve o usuário desativado como sucesso)', async () => {
      alloyal.criarUsuario.mockResolvedValue({ id: 9, active: false });
      alloyal.atualizarUsuario.mockRejectedValue(
        new IntegrationError({ vendor: 'alloyal', tipo: 'indisponivel' }),
      );

      await expect(servico.criar(associado, dados)).rejects.toBeInstanceOf(
        IntegrationError,
      );
    });

    it('CPF de terceiro no corpo → 403, sem chamar a Alloyal', async () => {
      await expect(
        servico.criar(associado, { ...dados, cpf: OUTRO_CPF }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      nenhumaChamada();
    });
  });

  describe('atualizar', () => {
    it('o próprio CPF no caminho → altera, sem consulta extra', async () => {
      await servico.atualizar(associado, CPF, { password: 'nova' });

      expect(alloyal.buscarUsuariosPorCpf).not.toHaveBeenCalled();
      expect(alloyal.atualizarUsuario).toHaveBeenCalledWith('MAIS_PRIME', CPF, {
        password: 'nova',
      });
    });

    it('id do usuário Alloyal do próprio associado (o que o app envia) → confere e altera', async () => {
      await servico.atualizar(associado, '900', { password: 'nova' });

      expect(alloyal.buscarUsuariosPorCpf).toHaveBeenCalledWith(
        'MAIS_PRIME',
        CPF,
      );
      expect(alloyal.atualizarUsuario).toHaveBeenCalledWith(
        'MAIS_PRIME',
        '900',
        {
          password: 'nova',
        },
      );
    });

    it.each([
      ['id de outro usuário', [{ id: 900, cpf: CPF }]],
      ['homônimo de outro CPF com o id pedido', [{ id: 901, cpf: OUTRO_CPF }]],
      ['busca vazia', []],
      ['busca fora do formato', { users: [] }],
    ])('%s → 403, sem alterar', async (_caso, encontrados) => {
      alloyal.buscarUsuariosPorCpf.mockResolvedValue(encontrados);

      await expect(
        servico.atualizar(associado, '901', { password: 'nova' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(alloyal.atualizarUsuario).not.toHaveBeenCalled();
    });

    it('a consulta de posse falhou → propaga a falha; nunca libera nem vira 403', async () => {
      const falha = new IntegrationError({
        vendor: 'alloyal',
        tipo: 'timeout',
      });
      alloyal.buscarUsuariosPorCpf.mockRejectedValue(falha);

      await expect(
        servico.atualizar(associado, '900', { password: 'nova' }),
      ).rejects.toBe(falha);
      expect(alloyal.atualizarUsuario).not.toHaveBeenCalled();
    });

    it('associado sem CPF no token, ou identificador sem dígitos → 403', async () => {
      await expect(
        servico.atualizar(
          { usuario: { userId: 7, role: 'USER' }, base: 'MAIS_PRIME' },
          '900',
          {},
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        servico.atualizar(associado, 'abc', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      nenhumaChamada();
    });

    it('ADMIN altera qualquer usuário sem consulta de posse', async () => {
      await servico.atualizar(admin, '901', { active: false });

      expect(alloyal.buscarUsuariosPorCpf).not.toHaveBeenCalled();
      expect(alloyal.atualizarUsuario).toHaveBeenCalledWith(
        'MAIS_PRIME_RS',
        '901',
        { active: false },
      );
    });

    it('ADMIN com identificador sem dígitos → recusa antes de chamar a Alloyal', async () => {
      const erro: unknown = await servico
        .atualizar(admin, 'abc', { active: false })
        .catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(DomainError);
      expect(erro).toMatchObject({ code: 'ALLOYAL_USUARIO_INVALIDO' });
      nenhumaChamada();
    });
  });
});
