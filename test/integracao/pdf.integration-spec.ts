import { BullModule } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetAppConfig } from 'src/config/app.config';
import { ChromiumPdfRenderer } from 'src/infra/pdf/chromium-pdf.renderer';
import { PdfPelaFila } from 'src/infra/pdf/pdf-pela-fila.renderer';
import { PdfRenderProcessor } from 'src/infra/pdf/pdf-render.processor';
import { PedidoDePdf } from 'src/infra/pdf/pdf-renderer';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { FILA_DE_MORTOS, PDF_QUEUE } from 'src/queue/filas';
import { IntegrationError } from 'src/shared/erros/erros';
import { describeComRedis, opcoesDoRedisDeTeste } from './ambiente';

const pedido: PedidoDePdf = {
  html: '<h1>Relatório de teste</h1>',
  modelo: 'teste',
  margem: { top: '1px', right: '1px', bottom: '1px', left: '1px' },
};

/**
 * Caminho da API em produção: o pedido vai pela fila ao processo `pdf` e o
 * PDF volta por arquivo. Aqui os dois lados rodam no mesmo módulo, com
 * BullMQ e Redis reais e um Chromium de mentira.
 */
describeComRedis('PDF pela fila — API pede, processo pdf renderiza', () => {
  let modulo: TestingModule;
  let pelaFila: PdfPelaFila;
  let diretorio: string;
  const chromium = { renderizar: jest.fn() };

  beforeAll(async () => {
    diretorio = await fs.mkdtemp(join(tmpdir(), 'pdf-troca-'));
    process.env.PDF_TMP_DIR = diretorio;
    process.env.PDF_PRAZO_MS = '5000';
    resetAppConfig();

    modulo = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection: opcoesDoRedisDeTeste(),
          prefix: `it-pdf-${process.pid}`,
        }),
        BullModule.registerQueue({ name: PDF_QUEUE }, { name: FILA_DE_MORTOS }),
      ],
      providers: [
        FilaDeMortosService,
        PdfPelaFila,
        PdfRenderProcessor,
        { provide: ChromiumPdfRenderer, useValue: chromium },
      ],
    }).compile();
    modulo.useLogger(false);
    await modulo.init();
    pelaFila = modulo.get(PdfPelaFila);
  });

  afterAll(async () => {
    await modulo.close();
    await fs.rm(diretorio, { recursive: true, force: true });
    delete process.env.PDF_TMP_DIR;
    delete process.env.PDF_PRAZO_MS;
    resetAppConfig();
  });

  beforeEach(() => {
    chromium.renderizar.mockReset();
  });

  it('devolve o PDF renderizado pelo outro lado e não deixa arquivo para trás', async () => {
    chromium.renderizar.mockImplementation((p: PedidoDePdf) =>
      Promise.resolve(Buffer.from(`%PDF-${p.modelo}-${p.html.length}`)),
    );

    const pdf = await pelaFila.renderizar(pedido);

    expect(pdf.toString()).toBe(`%PDF-teste-${pedido.html.length}`);
    expect(chromium.renderizar).toHaveBeenCalledWith({
      html: pedido.html,
      modelo: 'teste',
      margem: pedido.margem,
      paisagem: true,
    });
    expect(await fs.readdir(diretorio)).toEqual([]);
  });

  it('pedidos simultâneos recebem cada um o seu PDF', async () => {
    chromium.renderizar.mockImplementation((p: PedidoDePdf) =>
      Promise.resolve(Buffer.from(`pdf:${p.html}`)),
    );

    const pdfs = await Promise.all(
      ['a', 'b', 'c', 'd'].map((html) =>
        pelaFila.renderizar({ ...pedido, html }),
      ),
    );

    expect(pdfs.map((p) => p.toString())).toEqual([
      'pdf:a',
      'pdf:b',
      'pdf:c',
      'pdf:d',
    ]);
  });

  it('falha na renderização chega ao chamador como erro de integração e limpa os arquivos', async () => {
    chromium.renderizar.mockRejectedValue(new Error('Chromium caiu'));

    const erro = await pelaFila.renderizar(pedido).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(IntegrationError);
    expect(erro).toMatchObject({ vendor: 'pdf' });
    expect(await fs.readdir(diretorio)).toEqual([]);
  });

  it('renderização mais lenta que o prazo: a API desiste com timeout', async () => {
    chromium.renderizar.mockImplementation(
      () => new Promise((r) => setTimeout(() => r(Buffer.from('x')), 7_000)),
    );

    const erro = await pelaFila.renderizar(pedido).catch((e: unknown) => e);

    expect(erro).toMatchObject({
      vendor: 'pdf',
      tipo: 'timeout',
      statusHttp: 504,
    });
  }, 20_000);
});
