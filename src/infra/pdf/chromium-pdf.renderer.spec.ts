import type { Browser } from 'puppeteer';
import { ChromiumPdfRenderer } from 'src/infra/pdf/chromium-pdf.renderer';
import { PedidoDePdf } from 'src/infra/pdf/pdf-renderer';
import { IntegrationError } from 'src/shared/erros/erros';

const pedido = (modelo = 'teste'): PedidoDePdf => ({
  html: '<h1>Relatório</h1>',
  modelo,
  margem: { top: '10px', right: '10px', bottom: '10px', left: '10px' },
});

/** Navegador de mentira: cada `pdf()` espera a liberação do teste. */
function navegadorFalso() {
  const pendentes: Array<() => void> = [];
  let abertas = 0;
  let maximoAbertas = 0;
  const navegador = {
    connected: true,
    on: jest.fn(),
    close: jest.fn(() => {
      navegador.connected = false;
      return Promise.resolve();
    }),
    newPage: jest.fn(() => {
      abertas += 1;
      maximoAbertas = Math.max(maximoAbertas, abertas);
      return Promise.resolve({
        setContent: jest.fn().mockResolvedValue(undefined),
        pdf: jest.fn(
          () =>
            new Promise<Uint8Array>((resolver) => {
              pendentes.push(() => resolver(new Uint8Array([37, 80, 68, 70])));
            }),
        ),
        close: jest.fn(() => {
          abertas -= 1;
          return Promise.resolve();
        }),
      });
    }),
  };
  return {
    navegador,
    liberarUm: () => pendentes.shift()?.(),
    liberarTodos: () => pendentes.splice(0).forEach((f) => f()),
    pendentes: () => pendentes.length,
    maximoAbertas: () => maximoAbertas,
  };
}

class RendererDeTeste extends ChromiumPdfRenderer {
  aberturas = 0;
  constructor(private readonly fabrica: () => unknown) {
    super();
  }
  protected abrirNavegador(): Promise<Browser> {
    this.aberturas += 1;
    return Promise.resolve(this.fabrica() as Browser);
  }
}

const tick = () => new Promise((r) => setImmediate(r));

describe('ChromiumPdfRenderer', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reaproveita um único navegador entre os pedidos', async () => {
    const falso = navegadorFalso();
    const renderer = new RendererDeTeste(() => falso.navegador);

    for (let i = 0; i < 3; i++) {
      const promessa = renderer.renderizar(pedido());
      await tick();
      falso.liberarUm();
      const pdf = await promessa;
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    }

    expect(renderer.aberturas).toBe(1);
    expect(falso.navegador.newPage).toHaveBeenCalledTimes(3);
  });

  it('nunca passa do teto de páginas simultâneas (PDF_CONCORRENCIA = 2)', async () => {
    const falso = navegadorFalso();
    const renderer = new RendererDeTeste(() => falso.navegador);

    const promessas = Array.from({ length: 6 }, () =>
      renderer.renderizar(pedido()),
    );
    await tick();

    expect(renderer.estado()).toEqual({ emUso: 2, naEspera: 4 });
    expect(falso.pendentes()).toBe(2);

    while (falso.pendentes() > 0 || renderer.estado().emUso > 0) {
      falso.liberarTodos();
      await tick();
    }
    await Promise.all(promessas);

    expect(falso.maximoAbertas()).toBe(2);
    expect(renderer.estado()).toEqual({ emUso: 0, naEspera: 0 });
  });

  it('fila de espera cheia: recusa na hora em vez de enfileirar sem fim', async () => {
    const falso = navegadorFalso();
    const renderer = new RendererDeTeste(() => falso.navegador);
    const emCurso = Array.from({ length: 22 }, () =>
      renderer.renderizar(pedido()),
    );
    await tick();

    const erro = await renderer.renderizar(pedido()).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(IntegrationError);
    expect(erro).toMatchObject({ vendor: 'pdf', tipo: 'indisponivel' });

    while (renderer.estado().emUso > 0) {
      falso.liberarTodos();
      await tick();
    }
    await Promise.all(emCurso);
  });

  it('navegador que caiu é reaberto no pedido seguinte', async () => {
    const falsos = [navegadorFalso(), navegadorFalso()];
    let i = 0;
    const renderer = new RendererDeTeste(() => falsos[i++].navegador);

    const primeira = renderer.renderizar(pedido());
    await tick();
    falsos[0].liberarUm();
    await primeira;
    falsos[0].navegador.connected = false;

    const segunda = renderer.renderizar(pedido());
    await tick();
    falsos[1].liberarUm();
    await segunda;

    expect(renderer.aberturas).toBe(2);
  });

  it('erro na página devolve a vaga', async () => {
    const falso = navegadorFalso();
    falso.navegador.newPage.mockRejectedValueOnce(new Error('alvo fechado'));
    const renderer = new RendererDeTeste(() => falso.navegador);

    await expect(renderer.renderizar(pedido())).rejects.toThrow('alvo fechado');

    expect(renderer.estado()).toEqual({ emUso: 0, naEspera: 0 });
  });

  it('renderização presa: desiste no prazo, fecha o navegador e libera a vaga', async () => {
    jest.useFakeTimers();
    const falso = navegadorFalso();
    const renderer = new RendererDeTeste(() => falso.navegador);

    const promessa = renderer.renderizar(pedido()).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(91_000);
    const erro = await promessa;

    expect((erro as Error).message).toMatch(/excedeu 90s/);
    expect(falso.navegador.close).toHaveBeenCalled();
    expect(renderer.estado().emUso).toBe(0);
  });

  it('encerra o navegador no desligamento do processo', async () => {
    const falso = navegadorFalso();
    const renderer = new RendererDeTeste(() => falso.navegador);
    const promessa = renderer.renderizar(pedido());
    await tick();
    falso.liberarUm();
    await promessa;

    await renderer.onApplicationShutdown();

    expect(falso.navegador.close).toHaveBeenCalledTimes(1);
  });
});

/**
 * Chromium de verdade. Roda só com `TEST_PDF=1` (o CI não baixa o Chromium).
 */
(process.env.TEST_PDF === '1' ? describe : describe.skip)(
  'ChromiumPdfRenderer — Chromium real',
  () => {
    it('gera um PDF válido e reaproveita o navegador', async () => {
      const renderer = new ChromiumPdfRenderer();
      try {
        const [a, b] = await Promise.all([
          renderer.renderizar(pedido('real_a')),
          renderer.renderizar(pedido('real_b')),
        ]);
        expect(a.subarray(0, 5).toString()).toBe('%PDF-');
        expect(b.subarray(0, 5).toString()).toBe('%PDF-');
        expect(a.length).toBeGreaterThan(1_000);
      } finally {
        await renderer.onApplicationShutdown();
      }
    }, 60_000);
  },
);
