import { NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/database/prisma.service';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { AssociadoSincronizacaoService } from 'src/sga/services/associado-sincronizacao.service';
import { SgaService } from 'src/sga/services/sga.service';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';

/**
 * Caracterização das consultas ao associado: a resposta ao app não muda e a
 * sincronização do cadastro só dispara quando o SGA devolve um associado.
 */
describe('SgaService', () => {
  let service: SgaService;
  let prisma: {
    user: { findUnique: jest.Mock };
    userVehicle: { upsert: jest.Mock; updateMany: jest.Mock };
  };
  let sgaAuth: { executeRequestWithAuth: jest.Mock };
  let sincronizacao: { sincronizarEmSegundoPlano: jest.Mock };

  const usuarioDb = {
    id: 42,
    cpf: '529.982.247-25',
    baseOrigin: 'MAIS_PRIME_RS',
    name: 'Fulano de Tal',
    email: 'fulano@email.com',
    cep: '30130-010',
    address: 'Rua das Flores 123 Centro Belo Horizonte',
  };

  const associadoSga = {
    cpf: '52998224725',
    nome: 'Fulano de Tal',
    email: 'novo@email.com',
    descricao_situacao: 'ATIVO',
    veiculos: [{ chassi: '9BWZZZ377VT004251', placa: 'ABC1D23' }],
  };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(usuarioDb) },
      userVehicle: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    sgaAuth = { executeRequestWithAuth: jest.fn() };
    sincronizacao = { sincronizarEmSegundoPlano: jest.fn() };

    service = new SgaService(
      prisma as unknown as PrismaService,
      sgaAuth as unknown as SgaAuthService,
      {} as unknown as SuriNotificacaoService,
      {} as unknown as Queue,
      sincronizacao as unknown as AssociadoSincronizacaoService,
    );
  });

  describe('consultarAssociado', () => {
    it('devolve o corpo do SGA e dispara a sincronização com o usuário lido', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: associadoSga,
      });

      const resultado = await service.consultarAssociado(42);

      expect(resultado).toBe(associadoSga);
      expect(sincronizacao.sincronizarEmSegundoPlano).toHaveBeenCalledTimes(1);
      expect(sincronizacao.sincronizarEmSegundoPlano).toHaveBeenCalledWith(
        expect.objectContaining({ id: 42, cpf: '52998224725' }),
        associadoSga,
      );
    });

    it('consulta o SGA com CPF limpo e com a base de origem do usuário', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: associadoSga,
      });

      await service.consultarAssociado(42);

      // Uma única leitura no banco: sem relookup por CPF para resolver a base.
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledWith(
        'MAIS_PRIME_RS',
        expect.objectContaining({
          url: expect.stringMatching(/\/associado\/buscar\/52998224725$/),
        }),
      );
    });

    it('não sincroniza quando o SGA responde 406', async () => {
      const corpo406 = {
        mensagem: 'Não aceitável',
        error: ['Associado não encontrado'],
      };
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 406,
        data: corpo406,
      });

      const resultado = await service.consultarAssociado(42);

      expect(resultado).toBe(corpo406);
      expect(sincronizacao.sincronizarEmSegundoPlano).not.toHaveBeenCalled();
    });

    it('não sincroniza em erro 4xx/5xx e mantém o corpo de erro atual', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 500,
        data: null,
        statusText: 'Internal Server Error',
      });

      const resultado = await service.consultarAssociado(42);

      expect(resultado).toEqual({
        mensagem: 'Erro desconhecido',
        error: ['Internal Server Error'],
      });
      expect(sincronizacao.sincronizarEmSegundoPlano).not.toHaveBeenCalled();
    });

    it('lança NotFound quando o usuário não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.consultarAssociado(99)).rejects.toThrow(
        NotFoundException,
      );
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    });
  });

  describe('consultarVeiculosAssociado', () => {
    it('mantém a resposta (só veículos) e também dispara a sincronização', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: associadoSga,
      });

      const resultado = await service.consultarVeiculosAssociado(42);

      expect(resultado).toEqual(associadoSga.veiculos);
      expect(prisma.userVehicle.upsert).toHaveBeenCalledTimes(1);
      expect(sincronizacao.sincronizarEmSegundoPlano).toHaveBeenCalledTimes(1);
      expect(sincronizacao.sincronizarEmSegundoPlano).toHaveBeenCalledWith(
        expect.objectContaining({ id: 42, cpf: '52998224725' }),
        associadoSga,
      );
    });

    it('não sincroniza quando o SGA responde erro', async () => {
      const corpoErro = { mensagem: 'Não aceitável' };
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 406,
        data: corpoErro,
      });

      const resultado = await service.consultarVeiculosAssociado(42);

      expect(resultado).toBe(corpoErro);
      expect(sincronizacao.sincronizarEmSegundoPlano).not.toHaveBeenCalled();
      expect(prisma.userVehicle.upsert).not.toHaveBeenCalled();
    });
  });
});
