import {
  calcularDataAlvo,
  mascararCpf,
  mesPorExtenso,
  normalizarCpf,
  primeiroNome,
  renderizarMensagem,
} from 'src/boleto-notificacao/helpers/ciclo-cobranca.helper';

describe('ciclo-cobranca.helper', () => {
  describe('calcularDataAlvo', () => {
    it('calcula as datas-alvo pós-vencimento em dias corridos, cruzando o mês', () => {
      const hoje = new Date(2026, 2, 5, 15, 30); // 05/03/2026 15:30
      expect(calcularDataAlvo(hoje, 0)).toEqual(new Date(2026, 2, 5));
      expect(calcularDataAlvo(hoje, 1)).toEqual(new Date(2026, 2, 4));
      expect(calcularDataAlvo(hoje, 5)).toEqual(new Date(2026, 1, 28));
      expect(calcularDataAlvo(hoje, 6)).toEqual(new Date(2026, 1, 27));
      expect(calcularDataAlvo(hoje, 20)).toEqual(new Date(2026, 1, 13));
    });
  });

  describe('normalizarCpf', () => {
    it('remove máscara e repõe zeros à esquerda', () => {
      expect(normalizarCpf('529.982.247-25')).toBe('52998224725');
      expect(normalizarCpf(1234567890)).toBe('01234567890');
      expect(normalizarCpf('')).toBeNull();
      expect(normalizarCpf('123456789012345')).toBeNull();
    });

    it('aceita CNPJ (14 dígitos) no campo cpf de associado pessoa jurídica', () => {
      expect(normalizarCpf('58034733000127')).toBe('58034733000127');
      expect(normalizarCpf('58.034.733/0001-27')).toBe('58034733000127');
    });
  });

  describe('mascararCpf', () => {
    it('mantém apenas as pontas do documento', () => {
      expect(mascararCpf('52998224725')).toBe('529******25');
      expect(mascararCpf(null)).toBe('ausente');
    });
  });

  describe('renderizarMensagem (tokens da régua)', () => {
    const valores = {
      nome: 'Kaio',
      placa: 'ABC1D23',
      mes: 'Setembro',
      data: '10/09',
      vencimento: '10/09/2026',
      quantidade: 2,
    };

    it('substitui {nome}, {placa}, {mes} e {data}', () => {
      expect(
        renderizarMensagem(
          '{nome}, o boleto da proteção do {placa} vence hoje.',
          valores,
        ),
      ).toBe('Kaio, o boleto da proteção do ABC1D23 vence hoje.');

      expect(
        renderizarMensagem('Seu boleto de {mes} vence em {data}.', valores),
      ).toBe('Seu boleto de Setembro vence em 10/09.');
    });

    it('mantém os tokens legados {vencimento} e {quantidade}', () => {
      expect(
        renderizarMensagem('{quantidade} boleto(s) em {vencimento}', valores),
      ).toBe('2 boleto(s) em 10/09/2026');
    });
  });

  describe('primeiroNome', () => {
    it('extrai o primeiro nome com capitalização simples', () => {
      expect(primeiroNome('KAIO DA SILVA')).toBe('Kaio');
      expect(primeiroNome('maria souza')).toBe('Maria');
      expect(primeiroNome('LETAMOTOS LOCADORA LTDA')).toBe('Letamotos');
      expect(primeiroNome('')).toBe('Associado');
      expect(primeiroNome(undefined)).toBe('Associado');
    });
  });

  describe('mesPorExtenso', () => {
    it('converte mes_referente na competência por extenso', () => {
      expect(mesPorExtenso('09/2026')).toBe('Setembro');
      expect(mesPorExtenso('01/2026')).toBe('Janeiro');
      expect(mesPorExtenso('3/2026')).toBe('Março');
    });

    it('cai em fallback para valores inválidos', () => {
      expect(mesPorExtenso('')).toBe('este mês');
      expect(mesPorExtenso(undefined)).toBe('este mês');
      expect(mesPorExtenso('13/2026')).toBe('13/2026');
    });
  });
});
