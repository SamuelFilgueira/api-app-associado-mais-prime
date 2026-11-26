import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';

export interface RotaInventariada {
  /** `GET /associado/:id` (sem o prefixo global `/api`). */
  rota: string;
  controller: string;
  handler: string;
  /** Nomes dos guards da classe e do método, na ordem de execução. */
  guards: string[];
}

type Classe = abstract new (...args: never[]) => unknown;

/**
 * Lista todas as rotas HTTP a partir dos metadados dos módulos — sem subir a
 * aplicação, sem banco e sem Redis. Percorre `imports` e `controllers` a
 * partir do módulo raiz e lê, de cada handler, método, caminho e guards.
 */
export function inventariarRotas(moduloRaiz: unknown): RotaInventariada[] {
  const controllers = new Set<Classe>();
  const visitados = new Set<unknown>();

  const visitar = (alvo: unknown): void => {
    // `forRoot()`/`register()` devolvem `{ module, imports, controllers }`.
    const dinamico = alvo as {
      module?: unknown;
      imports?: unknown[];
      controllers?: Classe[];
    };
    const modulo = dinamico?.module ?? alvo;
    if (!modulo || visitados.has(modulo)) return;
    visitados.add(modulo);

    const listar = (chave: string): unknown[] =>
      (typeof modulo === 'function'
        ? (Reflect.getMetadata(chave, modulo) as unknown[] | undefined)
        : undefined) ?? [];

    for (const c of [
      ...listar('controllers'),
      ...(dinamico.controllers ?? []),
    ]) {
      controllers.add(c as Classe);
    }
    for (const importado of [
      ...listar('imports'),
      ...(dinamico.imports ?? []),
    ]) {
      visitar(importado);
    }
  };
  visitar(moduloRaiz);

  const rotas: RotaInventariada[] = [];
  for (const controller of controllers) {
    const prefixos = normalizar(Reflect.getMetadata(PATH_METADATA, controller));
    const guardsDaClasse = nomesDosGuards(controller);
    const prototipo = (controller as { prototype: Record<string, unknown> })
      .prototype;

    for (const nome of Object.getOwnPropertyNames(prototipo)) {
      const handler = prototipo[nome];
      if (nome === 'constructor' || typeof handler !== 'function') continue;
      const metodo = Reflect.getMetadata(METHOD_METADATA, handler) as
        | RequestMethod
        | undefined;
      if (metodo === undefined) continue;

      const caminhos = normalizar(Reflect.getMetadata(PATH_METADATA, handler));
      for (const prefixo of prefixos) {
        for (const caminho of caminhos) {
          rotas.push({
            rota: `${RequestMethod[metodo]} /${[prefixo, caminho].filter(Boolean).join('/')}`,
            controller: controller.name,
            handler: nome,
            guards: [...guardsDaClasse, ...nomesDosGuards(handler)],
          });
        }
      }
    }
  }

  return rotas.sort((a, b) => a.rota.localeCompare(b.rota));
}

function normalizar(caminho: unknown): string[] {
  const lista = Array.isArray(caminho) ? caminho : [caminho ?? ''];
  return lista.map((c) => String(c).replace(/^\/+|\/+$/g, ''));
}

function nomesDosGuards(alvo: object): string[] {
  const guards = (Reflect.getMetadata(GUARDS_METADATA, alvo) ?? []) as Array<
    { name?: string } | object
  >;
  return guards.map(
    (g) => (g as { name?: string }).name ?? g.constructor?.name ?? 'guard',
  );
}
