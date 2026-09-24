import {
  calcularAlteracoesCadastro,
  extrairCadastroSga,
  montarEnderecoSga,
} from 'src/sga/helpers/associado-sga.helper';

describe('associado-sga.helper', () => {
  const respostaSga = {
    cpf: '529.982.247-25',
    nome: 'Fulano de Tal',
    email: 'fulano@email.com',
    cep: '30130-010',
    logradouro: 'Rua das Flores',
    numero: '123',
    bairro: 'Centro',
    cidade: 'Belo Horizonte',
    descricao_situacao: 'ATIVO',
  };

  describe('montarEnderecoSga', () => {
    it('reproduz o formato do cadastro inicial (primeiroAcesso)', () => {
      expect(montarEnderecoSga(respostaSga)).toBe(
        'Rua das Flores 123 Centro Belo Horizonte',
      );
    });

    it('ignora partes vazias e aceita número numérico', () => {
      expect(
        montarEnderecoSga({
          logradouro: 'Av. Brasil',
          numero: 45,
          bairro: '',
          cidade: null,
        }),
      ).toBe('Av. Brasil 45');
    });

    it('retorna null quando nenhuma parte foi informada', () => {
      expect(montarEnderecoSga({})).toBeNull();
    });
  });

  describe('extrairCadastroSga', () => {
    it('extrai os campos de um objeto direto', () => {
      expect(extrairCadastroSga(respostaSga)).toEqual({
        cpf: '52998224725',
        name: 'Fulano de Tal',
        email: 'fulano@email.com',
        cep: '30130-010',
        address: 'Rua das Flores 123 Centro Belo Horizonte',
      });
    });

    it('aceita array com um elemento', () => {
      expect(extrairCadastroSga([respostaSga])?.name).toBe('Fulano de Tal');
    });

    it('normaliza espaços e descarta campos vazios', () => {
      const cadastro = extrairCadastroSga({
        nome: '  Fulano  ',
        email: '   ',
        cep: null,
      });

      expect(cadastro).toEqual({
        cpf: null,
        name: 'Fulano',
        email: null,
        cep: null,
        address: null,
      });
    });

    it('descarta e-mail sem "@"', () => {
      expect(
        extrairCadastroSga({ nome: 'Fulano', email: 'sem-email' }),
      ).toEqual(expect.objectContaining({ email: null }));
    });

    it('retorna null para corpos que não são um associado', () => {
      expect(extrairCadastroSga(null)).toBeNull();
      expect(extrairCadastroSga(undefined)).toBeNull();
      expect(extrairCadastroSga('texto')).toBeNull();
      expect(extrairCadastroSga([])).toBeNull();
      expect(
        extrairCadastroSga({
          mensagem: 'Não aceitável',
          error: ['Associado não encontrado'],
        }),
      ).toBeNull();
    });
  });

  describe('calcularAlteracoesCadastro', () => {
    const local = {
      name: 'Fulano de Tal',
      email: 'fulano@email.com',
      cep: '30130-010',
      address: 'Rua das Flores 123 Centro Belo Horizonte',
    };

    it('retorna objeto vazio quando nada mudou (caminho sem escrita)', () => {
      expect(
        calcularAlteracoesCadastro(local, extrairCadastroSga(respostaSga)!),
      ).toEqual({});
    });

    it('retorna apenas os campos que mudaram', () => {
      const sga = extrairCadastroSga({
        ...respostaSga,
        email: 'novo@email.com',
        numero: '456',
      })!;

      expect(calcularAlteracoesCadastro(local, sga)).toEqual({
        email: 'novo@email.com',
        address: 'Rua das Flores 456 Centro Belo Horizonte',
      });
    });

    it('nunca apaga valor local quando o SGA não informa o campo', () => {
      const sga = extrairCadastroSga({ nome: 'Fulano de Tal' })!;

      expect(calcularAlteracoesCadastro(local, sga)).toEqual({});
    });

    it('preenche campo local nulo quando o SGA informa', () => {
      const sga = extrairCadastroSga(respostaSga)!;

      expect(
        calcularAlteracoesCadastro({ ...local, cep: null, address: null }, sga),
      ).toEqual({
        cep: '30130-010',
        address: 'Rua das Flores 123 Centro Belo Horizonte',
      });
    });
  });
});
