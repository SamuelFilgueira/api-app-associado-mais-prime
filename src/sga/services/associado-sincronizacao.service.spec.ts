import { Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import {
  AssociadoSincronizacaoService,
  UsuarioSincronizavel,
} from 'src/sga/services/associado-sincronizacao.service';

describe('AssociadoSincronizacaoService', () => {
  let service: AssociadoSincronizacaoService;
  let prisma: { user: { update: jest.Mock } };
  let warnSpy: jest.SpyInstance;

  const usuario: UsuarioSincronizavel = {
    id: 42,
    cpf: '52998224725',
    baseOrigin: 'MAIS_PRIME',
    name: 'Fulano de Tal',
    email: 'fulano@email.com',
    cep: '30130-010',
    address: 'Rua das Flores 123 Centro Belo Horizonte',
  };

  const respostaSga = {
    cpf: '52998224725',
    nome: 'Fulano de Tal',
    email: 'fulano@email.com',
    cep: '30130-010',
    logradouro: 'Rua das Flores',
    numero: '123',
    bairro: 'Centro',
    cidade: 'Belo Horizonte',
  };

  const aguardarSegundoPlano = () =>
    new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    prisma = { user: { update: jest.fn().mockResolvedValue({}) } };
    service = new AssociadoSincronizacaoService(
      prisma as unknown as PrismaService,
    );
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('sincronizar', () => {
    it('não escreve no banco quando os dados são iguais', async () => {
      const resultado = await service.sincronizar(usuario, respostaSga);

      expect(resultado).toEqual({});
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('grava apenas os campos que mudaram no SGA', async () => {
      const resultado = await service.sincronizar(usuario, {
        ...respostaSga,
        email: 'novo@email.com',
        cep: '30140-000',
      });

      expect(resultado).toEqual({ email: 'novo@email.com', cep: '30140-000' });
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 42 },
        data: { email: 'novo@email.com', cep: '30140-000' },
      });
    });

    it('aceita resposta em array (formato alternativo da Hinova)', async () => {
      const resultado = await service.sincronizar(usuario, [
        { ...respostaSga, nome: 'Fulano Atualizado' },
      ]);

      expect(resultado).toEqual({ name: 'Fulano Atualizado' });
    });

    it('ignora quando o CPF retornado pelo SGA é de outra pessoa', async () => {
      const resultado = await service.sincronizar(usuario, {
        ...respostaSga,
        cpf: '01234567890',
        email: 'outro@email.com',
      });

      expect(resultado).toEqual({});
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('ignora corpos de erro retornados em 2xx', async () => {
      const resultado = await service.sincronizar(usuario, {
        mensagem: 'Não aceitável',
        error: ['Associado não encontrado'],
      });

      expect(resultado).toEqual({});
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('não apaga campos locais quando o SGA devolve vazio', async () => {
      const resultado = await service.sincronizar(usuario, {
        cpf: '52998224725',
        nome: 'Fulano de Tal',
        email: '',
        cep: null,
      });

      expect(resultado).toEqual({});
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('sincronizarEmSegundoPlano', () => {
    it('não propaga falha do banco e registra warning', async () => {
      prisma.user.update.mockRejectedValue(new Error('banco indisponível'));

      expect(() =>
        service.sincronizarEmSegundoPlano(usuario, {
          ...respostaSga,
          email: 'novo@email.com',
        }),
      ).not.toThrow();

      await aguardarSegundoPlano();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('banco indisponível'),
      );
    });

    it('dispara a gravação sem bloquear o chamador', async () => {
      service.sincronizarEmSegundoPlano(usuario, {
        ...respostaSga,
        email: 'novo@email.com',
      });

      await aguardarSegundoPlano();

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });
  });
});
