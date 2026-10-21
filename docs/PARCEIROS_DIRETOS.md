# Parceiros diretos (Clube de Vantagens)

Implementação da spec `CONTRATO_PARCEIROS_DIRETOS.md` v1.1 (repositório do app, 2026-10-19).
Módulo: `src/direct-partners/`.

## Rotas

| Público | Base | Guard |
|---|---|---|
| Painel (tela "Parceiros diretos") | `/api/admin/parceiros-diretos` | `JwtAuthGuard` + `AdminPanelRoleGuard` + `@AdminPanelRoles(MARKETING)` |
| App do associado | `/api/clube/parceiros-diretos` | `JwtAuthGuard` (base e `userId` do JWT) |

Painel: `GET /opcoes`, `PATCH /ordenar`, `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id?hard=`, `POST|DELETE /:id/logo`, `GET|POST /:id/cupons`, `PATCH|DELETE /:id/cupons/:cupomId`, `GET /:id/cupons/:cupomId/resgates`.

App: `GET /`, `GET /:id`, `POST /:id/cupons/:cupomId/resgatar`.

Todas documentadas no Swagger (`/docs`, tag "Parceiros diretos").

## Migration (pendente de execução)

O schema já contém os modelos `DirectPartner`, `DirectPartnerBase`, `DirectPartnerCoupon`,
`DirectPartnerCouponRedemption` e os enums `DirectPartnerCategory` / `DirectPartnerTone`,
além da relação inversa `user.directPartnerRedemptions`.

```bash
npx prisma migrate dev --name direct_partners
npx prisma generate
```

Em produção: `npx prisma migrate deploy`.

## Decisões de implementação

- **Multi-base**: o operador escolhe 1..N bases (`baseOrigins`), validadas por `isTenantBase()`.
  O painel lista todas as bases do deploy (`TENANT.baseNames`), não só a do operador.
  Toda leitura do app filtra `bases.some({ baseOrigin: JWT })`; o resgate grava a base do JWT.
- **Categorias da Alloyal no formulário (§5.0)**: a API da Alloyal só devolve `/categories` com
  sessão de usuário final (uid/client/access-token), que o painel não possui. Por isso
  `AlloyalCategoriesCacheService` (exportado por `AlloyalApiModule`) guarda em Redis, por base,
  a lista `{ id, title }` sempre que um associado chama `GET /alloyal/categories`
  (TTL 7 dias, chave `alloyal:categorias:<base>`). Base sem cache devolve `[]`.
  A injeção no `AlloyalApiController` é `@Optional()` para manter o contract spec verde sem edição.
- **Uso único**: `DirectPartnersRepository.resgatarUsoUnico` roda em transação com
  `SELECT ... FOR UPDATE` na linha do cupom e leitura travada do par (cupom, associado), garantindo
  um único registro mesmo com chamadas simultâneas. Cupom reutilizável grava uma linha por uso (métrica).
- **Hard delete**: `AdminPanelRoleGuard` só verifica `role === ADMIN` (todo usuário do painel).
  Por isso `?hard=true` confere `adminRole === 'ADMIN'` no serviço e responde 403 para os demais perfis.
- **Datas de cupom**: `validFrom`/`validUntil` chegam como `yyyy-mm-dd` e são persistidas como
  meia-noite local (TZ `America/Sao_Paulo`). Visível = `validUntil >= início de hoje` (fim do dia inclusivo).
- **Erros com `code`** (§7): `BASE_INVALIDA`, `PERIODO_INVALIDO`, `HORARIO_INVALIDO` (422),
  `CODIGO_DUPLICADO`, `CUPOM_JA_UTILIZADO` (409). O `HttpExceptionFilter` devolve o objeto como enviado.
- **Logo**: `FileUploadService.uploadDirectPartnerLogo` grava WebP até 512×512 em
  `uploads/direct-partners/<id>-<timestamp>.webp`; multer limita a 2 MB (413) e o `fileFilter`
  rejeita tipos fora de JPG/PNG/WebP (400).
- **Busca** usa `contains` sem `mode: 'insensitive'` (não suportado no MySQL pelo Prisma);
  a collation padrão do banco já é case-insensitive.

## Fora da v1 (conforme spec)

Avaliações, validação pelo lojista (QR Code), estoque de cupons, imagem de capa (campo reservado).
Seed dos 8 parceiros do mock não foi criado.
