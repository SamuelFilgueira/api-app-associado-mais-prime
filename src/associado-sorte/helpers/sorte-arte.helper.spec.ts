import sharp from 'sharp';
import {
  conferirArte,
  ehSlotDeArte,
  validarArte,
} from 'src/associado-sorte/helpers/sorte-arte.helper';

const png = (largura: number, altura: number) =>
  sharp({
    create: {
      width: largura,
      height: altura,
      channels: 3,
      background: '#d9251c',
    },
  })
    .png()
    .toBuffer();

/** GIF animado de `quadros` quadros (cores diferentes para não ser fundido). */
const gif = async (largura: number, altura: number, quadros = 3) => {
  const telas = await Promise.all(
    Array.from({ length: quadros }, (_, i) =>
      sharp({
        create: {
          width: largura,
          height: altura,
          channels: 3,
          background: { r: (i * 70) % 255, g: 40, b: 40 },
        },
      })
        .png()
        .toBuffer(),
    ),
  );
  return sharp(telas, { join: { animated: true } })
    .gif()
    .toBuffer();
};

describe('arte da raspadinha', () => {
  it('aceita PNG 1200×600 em qualquer espaço', async () => {
    const arquivo = await png(1200, 600);
    for (const slot of ['capa', 'ganhou', 'naoGanhou'] as const) {
      const r = await validarArte(slot, arquivo);
      expect(r).toMatchObject({
        ok: true,
        arte: { formato: 'png', largura: 1200, altura: 600, animada: false },
      });
    }
  });

  it('recusa proporção diferente de 2:1 e imagem pequena', async () => {
    const quadrada = await validarArte('capa', await png(1000, 1000));
    expect(quadrada).toMatchObject({ ok: false });
    expect((quadrada as { mensagem: string }).mensagem).toContain('2:1');

    const pequena = await validarArte('capa', await png(600, 300));
    expect((pequena as { mensagem: string }).mensagem).toContain(
      'mínimo é 900×450',
    );
  });

  it('GIF animado: recusado na capa, aceito em ganhou/naoGanhou (mede um quadro)', async () => {
    const animacao = await gif(800, 400);
    const capa = await validarArte('capa', animacao);
    expect((capa as { mensagem: string }).mensagem).toContain('estática');

    expect(await validarArte('ganhou', animacao)).toMatchObject({
      ok: true,
      arte: {
        formato: 'gif',
        largura: 800,
        altura: 400,
        animada: true,
        quadros: 3,
      },
    });
    expect(await validarArte('naoGanhou', animacao)).toMatchObject({
      ok: true,
    });
  });

  it('limites de peso e de quadros', () => {
    const estatica = {
      formato: 'png',
      largura: 1200,
      altura: 600,
      animada: false,
      quadros: 1,
    } as const;
    expect(conferirArte('capa', estatica, 1024 * 1024)).toBeNull();
    expect(conferirArte('capa', estatica, 1024 * 1024 + 1)).toContain('1 MB');

    const animada = {
      formato: 'gif',
      largura: 800,
      altura: 400,
      animada: true,
      quadros: 60,
    } as const;
    expect(conferirArte('ganhou', animada, 3 * 1024 * 1024)).toBeNull();
    expect(conferirArte('ganhou', animada, 3 * 1024 * 1024 + 1)).toContain(
      '3 MB',
    );
    expect(
      conferirArte('ganhou', { ...animada, quadros: 121 }, 1000),
    ).toContain('quadros');
    expect(
      conferirArte('ganhou', { ...animada, largura: 1600, altura: 800 }, 1000),
    ).toContain('máximo');
  });

  it('recusa arquivo que não é imagem (ex.: MP4) e slot desconhecido', async () => {
    const r = await validarArte(
      'ganhou',
      Buffer.from('\x00\x00\x00\x18ftypmp42 não sou imagem'),
    );
    expect(r.ok).toBe(false);
    expect(ehSlotDeArte('capa')).toBe(true);
    expect(ehSlotDeArte('video')).toBe(false);
  });
});
