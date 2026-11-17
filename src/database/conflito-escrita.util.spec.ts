import {
  comRetryEmConflito,
  isConflitoEscritaConcorrente,
} from 'src/database/conflito-escrita.util';

describe('conflito-escrita.util', () => {
  const erro1020 = new Error(
    'Invalid `prisma.reinspection.update()` invocation: MysqlError { code: 1020, message: "Record has changed since last read in table \'Reinspection\'; try restarting transaction" }',
  );

  it('reconhece 1020 do MariaDB, deadlock e P2034', () => {
    expect(isConflitoEscritaConcorrente(erro1020)).toBe(true);
    expect(
      isConflitoEscritaConcorrente(new Error('Deadlock found when trying')),
    ).toBe(true);
    expect(isConflitoEscritaConcorrente({ code: 'P2034' })).toBe(true);
    expect(isConflitoEscritaConcorrente(new Error('outro erro'))).toBe(false);
    expect(isConflitoEscritaConcorrente(null)).toBe(false);
  });

  it('repete em conflito e devolve o resultado', async () => {
    const operacao = jest
      .fn()
      .mockRejectedValueOnce(erro1020)
      .mockResolvedValue('ok');
    await expect(comRetryEmConflito(operacao)).resolves.toBe('ok');
    expect(operacao).toHaveBeenCalledTimes(2);
  });

  it('não repete erro que não é conflito', async () => {
    const operacao = jest.fn().mockRejectedValue(new Error('outro erro'));
    await expect(comRetryEmConflito(operacao)).rejects.toThrow('outro erro');
    expect(operacao).toHaveBeenCalledTimes(1);
  });

  it('desiste após o limite de tentativas', async () => {
    const operacao = jest.fn().mockRejectedValue(erro1020);
    await expect(comRetryEmConflito(operacao, 3)).rejects.toBe(erro1020);
    expect(operacao).toHaveBeenCalledTimes(3);
  });
});
