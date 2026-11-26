import { ConsultasPorProvedorService } from 'src/rastreamento/services/consultas-por-provedor.service';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';

/**
 * A resposta da renovação do token M7 informa o resultado por base, mas não
 * devolve a credencial do vendor.
 */
describe('RastreamentoService.renovarTokenM7', () => {
  it('não devolve o token M7 nem a mensagem crua do erro', async () => {
    const m7 = {
      renovarToken: jest
        .fn()
        .mockResolvedValueOnce({ token: 'SEGREDO-M7', expires_in: 3600 })
        .mockRejectedValueOnce(new Error('login recusado: senha XPTO')),
    };
    // Só a M7 importa aqui: os demais colaboradores não são usados.
    const porProvedor = Object.create(
      ConsultasPorProvedorService.prototype,
    ) as ConsultasPorProvedorService;
    (porProvedor as unknown as { m7: typeof m7 }).m7 = m7;
    const service = new RastreamentoService(
      undefined as never,
      undefined as never,
      undefined as never,
      porProvedor,
    );

    const resposta = await service.renovarTokenM7();
    const bases = Object.keys(resposta);

    expect(bases.length).toBeGreaterThan(0);
    expect(resposta[bases[0]]).toEqual({ renovado: true, expires_in: 3600 });
    expect(JSON.stringify(resposta)).not.toContain('SEGREDO-M7');
    expect(JSON.stringify(resposta)).not.toContain('XPTO');
  });
});
