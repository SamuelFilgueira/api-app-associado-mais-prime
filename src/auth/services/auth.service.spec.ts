import {
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from 'src/auth/services/auth.service';
import { PrismaService } from 'src/database/prisma.service';
import { MailService } from 'src/infra/mail/mail.service';

/**
 * Redefinição de senha: a senha só pode ser trocada no banco depois que o
 * e-mail com a nova senha saiu. Falha no provedor de e-mail tem que virar
 * resposta HTTP clara (503), nunca requisição pendurada nem usuário sem acesso.
 */
describe('AuthService.resetPassword', () => {
  const usuario = {
    id: 7,
    cpf: '12345678901',
    email: 'associado@exemplo.com.br',
    passwordHash: 'hash-antigo',
  };

  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
  };
  const mail = { sendPasswordReset: jest.fn() };

  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue(usuario);
    prisma.user.update.mockResolvedValue(usuario);
    mail.sendPasswordReset.mockResolvedValue(undefined);
    service = new AuthService(
      prisma as unknown as PrismaService,
      {} as JwtService,
      mail as unknown as MailService,
    );
    // Silencia o log de erro esperado nos cenários de falha
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  it('CPF sem conta responde 404 e não envia nem grava nada', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.resetPassword('00000000000')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mail.sendPasswordReset).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('envia o e-mail antes de gravar e grava o hash da senha enviada', async () => {
    const resultado = await service.resetPassword(usuario.cpf);

    expect(resultado).toEqual({
      message: 'Nova senha enviada para o e-mail informado',
      email: usuario.email,
    });

    const ordemEnvio = mail.sendPasswordReset.mock.invocationCallOrder[0];
    const ordemGravacao = prisma.user.update.mock.invocationCallOrder[0];
    expect(ordemEnvio).toBeLessThan(ordemGravacao);

    const [destino, senhaEnviada] = mail.sendPasswordReset.mock.calls[0];
    expect(destino).toBe(usuario.email);

    const { where, data } = prisma.user.update.mock.calls[0][0];
    expect(where).toEqual({ cpf: usuario.cpf });
    expect(data.primeiroLogin).toBe(true);
    expect(await bcrypt.compare(senhaEnviada, data.passwordHash)).toBe(true);
  });

  it('falha no envio do e-mail responde 503 e mantém a senha atual', async () => {
    mail.sendPasswordReset.mockRejectedValue(
      Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }),
    );

    const erro = await service.resetPassword(usuario.cpf).catch((e) => e);

    expect(erro).toBeInstanceOf(ServiceUnavailableException);
    expect(erro.getResponse()).toMatchObject({
      statusCode: 503,
      message:
        'Não foi possível enviar o e-mail de recuperação de senha. Tente novamente em alguns minutos.',
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('conta sem e-mail responde 422 sem tentar enviar nem trocar a senha', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...usuario, email: '  ' });

    await expect(service.resetPassword(usuario.cpf)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(mail.sendPasswordReset).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
