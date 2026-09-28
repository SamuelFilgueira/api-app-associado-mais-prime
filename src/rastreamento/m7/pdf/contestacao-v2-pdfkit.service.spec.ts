import { PassThrough } from 'stream';
import { HistoricoM7ContestacaoPontoDto } from '../dto/historico-m7-response.dto';
import { ContestacaoV2PdfKitService } from './contestacao-v2-pdfkit.service';

function coletor() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finalizado = new Promise<Buffer>((resolve) => {
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  return {
    stream,
    finalizado,
    bytesRecebidos: () => chunks.reduce((acc, c) => acc + c.length, 0),
  };
}

function gerarPontos(quantidade: number): HistoricoM7ContestacaoPontoDto[] {
  return Array.from({ length: quantidade }, (_, i) => ({
    placa: 'ABC1D23',
    dataGps: `2026-09-01 12:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
    velocidade: i % 3 === 0 ? 0 : 42,
    latitude: (-22.9 - i * 0.00001).toFixed(6),
    longitude: (-43.2 - i * 0.00001).toFixed(6),
    endereco:
      i % 7 === 0
        ? 'Avenida das Américas, 4666, Barra da Tijuca, Rio de Janeiro, RJ — trecho longo para forçar quebra de linha na coluna de endereço do relatório'
        : `Rua Teste ${i}, Bairro Teste, Rio de Janeiro, RJ`,
  }));
}

const cabecalho = {
  veiculo: { codigo: 1, placa: 'ABC1D23', chassi: '9BWZZZ377VT004251' },
  periodo: { dataInicial: '2026-09-01', dataFinal: '2026-09-04' },
  totalPontos: 0,
  intervaloMinSeg: 10,
};

describe('ContestacaoV2PdfKitService', () => {
  const service = new ContestacaoV2PdfKitService();

  it('gera um PDF válido com poucos pontos', async () => {
    const { stream, finalizado } = coletor();
    const pontos = gerarPontos(3);

    const writer = service.criarWriter(
      { ...cabecalho, totalPontos: pontos.length },
      stream,
    );
    writer.escreverLinhas(pontos);
    await writer.finalizar();

    const pdf = await finalizado;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('%%EOF');
  });

  it('gera PDF sem pontos com a linha de aviso', async () => {
    const { stream, finalizado } = coletor();
    const writer = service.criarWriter(
      { ...cabecalho, totalPontos: 0 },
      stream,
    );
    await writer.finalizar();

    const pdf = await finalizado;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('pagina milhares de pontos e envia bytes antes de finalizar (streaming)', async () => {
    const { stream, finalizado, bytesRecebidos } = coletor();
    const pontos = gerarPontos(3000);

    const writer = service.criarWriter(
      { ...cabecalho, totalPontos: pontos.length },
      stream,
    );
    writer.escreverLinhas(pontos.slice(0, 1500));
    // Dá vez ao event loop: páginas fechadas já devem ter sido descarregadas.
    await new Promise((r) => setImmediate(r));
    const bytesAntesDoFim = bytesRecebidos();
    writer.escreverLinhas(pontos.slice(1500));
    await writer.finalizar();

    const pdf = await finalizado;
    const paginas = (pdf.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? [])
      .length;

    expect(bytesAntesDoFim).toBeGreaterThan(0);
    expect(paginas).toBeGreaterThan(50);
    expect(pdf.length).toBeGreaterThan(bytesAntesDoFim);
  }, 30_000);
});
