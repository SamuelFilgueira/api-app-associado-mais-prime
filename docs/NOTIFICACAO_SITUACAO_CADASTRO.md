# Notificação Push por Planilha de CPFs — Mudança de Situação no Cadastro

> **Data:** 2026-08-24
> **Rota nova:** `POST /api/notifications/admin/situacao-cadastro`
> **Acesso:** somente usuários com `role === "ADMIN"` no JWT
> **Nenhuma rota ou recurso existente foi alterado.**

## 1. O que foi adicionado no backend

| Arquivo | Tipo | Descrição |
|---|---|---|
| `src/notifications/dto/send-situacao-cadastro-notification.dto.ts` | **novo** | DTO da rota (`title`, `body`, `data` opcional como string JSON — a requisição é multipart) |
| `src/notifications/services/situacao-cadastro-notification.service.ts` | **novo** | Parse da planilha `.xlsx` (exceljs), normalização/validação de CPF (dígitos verificadores), resolução dos usuários elegíveis, envio via Expo em chunks e persistência no histórico de notificações |
| `src/notifications/services/situacao-cadastro-notification.service.spec.ts` | **novo** | Testes unitários do parse da planilha, validação de CPF e parse do campo `data` (9 testes) |
| `src/notifications/controllers/notifications.controller.ts` | alterado (aditivo) | Novo handler `POST admin/situacao-cadastro`; nenhum handler existente foi tocado |
| `src/notifications/notifications.module.ts` | alterado (aditivo) | Registro do novo provider |
| `package.json` | alterado | Nova dependência: `exceljs` (leitura de `.xlsx`) |

Não houve migration: a rota reutiliza os modelos existentes `user` (busca por `cpf`), `notification` (histórico exibido no app) e `marketingNotificationAuditLog` (auditoria de quem disparou o envio, com `messagePayload.type = "situacao_cadastro"` para diferenciar dos envios de marketing).

### Regras de negócio do envio

1. A planilha é lida da **primeira aba**. Se a primeira linha tiver um cabeçalho contendo "cpf" (qualquer coluna, case-insensitive), essa coluna é usada e a leitura começa na linha 2; caso contrário, usa-se a **coluna A** desde a linha 1.
2. Cada CPF é normalizado: máscara removida (`529.982.247-25` → `52998224725`) e zeros à esquerda repostos (células numéricas do Excel perdem o zero inicial: `1234567890` → `01234567890`).
3. CPFs com dígitos verificadores inválidos são rejeitados e reportados; duplicados são removidos.
4. Limite de **10.000 CPFs únicos** por envio (acima disso: `400`).
5. Elegível para receber o push: usuário existe no banco (`user.cpf`), está `isActive` e possui `expoPushToken` válido. **Não** há filtro de `acceptsMarketingNotifications` — é notificação de cadastro/cobrança, não promocional.
6. O envio é feito em chunks via Expo (mesmo mecanismo da rota de marketing). Apenas os pushes com ticket `ok` são gravados na tabela `notification` (aparecem no sino/histórico do app do associado).
7. O envio é **síncrono**: a resposta já traz o relatório completo. Para 10k CPFs a requisição pode levar alguns segundos — o frontend deve exibir loading e usar timeout generoso (60s+).
8. **Correção de encoding (UTF-8):** se `title`/`body` (ou valores de texto do `data`) chegarem com mojibake — UTF-8 interpretado como latin1/cp1252, ex.: `AtualizaÃ§Ã£o` — o backend detecta o padrão e corrige automaticamente antes de enviar e persistir. Texto já correto passa intocado.
9. **Deep-link para boletos:** por padrão o payload é `{"type":"internal_route","screen":"financeiro"}`. Ao tocar na notificação, o app navega para a tela de boletos: com **um único veículo** vai direto para `/financeiro/[placa]`; com **mais de um**, abre `/financeiro/selecionar-veiculo` (mesma lógica do fluxo de boletos da Home, sem validação de situação). Implementado no app em `app/_layout.tsx` (`handleNotificationRedirect`, case `internal_route`) — funciona com app em foreground, background e cold start (a navegação aguarda a sessão restaurar).

## 2. Contrato da API (frontend do painel administrativo)

### Requisição

```
POST /api/notifications/admin/situacao-cadastro
Authorization: Bearer <JWT do usuário ADMIN>
Content-Type: multipart/form-data
```

| Campo (form-data) | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `file` | arquivo `.xlsx` | sim | Planilha com os CPFs (máx. **5 MB**). Somente `.xlsx` — `.xls` legado e `.csv` não são aceitos |
| `title` | texto | sim | Título do push (mesmo formato da rota de marketing) |
| `body` | texto | sim | Corpo do push |
| `data` | texto (JSON) | não | **String JSON** com payload extra, mesmo formato do `data` da rota de marketing. Ex.: `{"type":"internal_route","screen":"financeiro"}`. Se omitido, o backend usa `{"type":"internal_route","screen":"financeiro"}` — o toque na notificação leva o associado à tela de boletos do app |

Exemplo (JS/fetch):

```js
const formData = new FormData();
formData.append('file', arquivoXlsx); // File do input
formData.append('title', 'Atualização de cadastro');
formData.append('body', 'Sua situação foi alterada para Inadimplente. Regularize seu boleto.');
formData.append('data', JSON.stringify({ type: 'internal_route', screen: 'Boletos' }));

const res = await fetch(`${API_URL}/api/notifications/admin/situacao-cadastro`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` }, // NÃO setar Content-Type manualmente
  body: formData,
});
```

> **Importante:** não definir `Content-Type` manualmente no fetch/axios — o browser gera o boundary do multipart sozinho.

### Resposta de sucesso (`200 OK`)

```json
{
  "sentCount": 142,
  "skippedCount": 8,
  "resumo": {
    "totalLinhasPlanilha": 152,
    "cpfsValidos": 150,
    "cpfsInvalidos": ["111.111.111-11", "abc"],
    "cpfsDuplicadosRemovidos": 0,
    "cpfsNaoEncontrados": ["12345678909"],
    "cpfsInativos": ["98765432100"],
    "cpfsSemToken": ["45678912304", "78912345607"],
    "cpfsComFalhaEnvio": []
  }
}
```

| Campo | Significado |
|---|---|
| `sentCount` | Pushes efetivamente enviados (ticket `ok` no Expo) e gravados no histórico do app |
| `skippedCount` | Total de CPFs válidos que **não** receberam (soma das 4 listas abaixo) |
| `resumo.totalLinhasPlanilha` | Linhas não vazias lidas da coluna de CPF |
| `resumo.cpfsValidos` | CPFs únicos com dígitos verificadores corretos |
| `resumo.cpfsInvalidos` | Valores rejeitados na validação (retornados como vieram na planilha) |
| `resumo.cpfsDuplicadosRemovidos` | Quantidade de repetições descartadas |
| `resumo.cpfsNaoEncontrados` | CPFs sem cadastro no app (normalizados, 11 dígitos) |
| `resumo.cpfsInativos` | Usuário existe mas está desativado no app |
| `resumo.cpfsSemToken` | Usuário existe mas nunca aceitou/registrou push (sem `expoPushToken` válido) |
| `resumo.cpfsComFalhaEnvio` | Falha no Expo na hora do envio (pode-se reenviar só estes) |

### Erros

| Status | Quando | Corpo (`message`) |
|---|---|---|
| `400` | Sem arquivo no campo `file` | `A planilha Excel (.xlsx) é obrigatória no campo "file"` |
| `400` | Arquivo que não é `.xlsx` | `Formato de arquivo não suportado. Envie uma planilha .xlsx` |
| `400` | Planilha vazia / sem CPF válido | `Nenhum CPF válido encontrado na planilha...` |
| `400` | Mais de 10.000 CPFs únicos | `A planilha excede o limite de 10000 CPFs por envio` |
| `400` | Campo `data` com JSON inválido | `O campo "data" não é um JSON válido` |
| `400` | `title`/`body` ausentes ou vazios | mensagem do ValidationPipe |
| `401` | Sem JWT ou JWT inválido | padrão do `JwtAuthGuard` |
| `403` | JWT válido mas `role !== ADMIN` | `Apenas usuários ADMIN podem acessar este recurso` |
| `413` | Arquivo maior que 5 MB | padrão do Multer |

## 3. O que implementar no frontend do painel

1. **Gate de acesso:** exibir a tela/botão apenas para operadores com `role === "ADMIN"` (o backend bloqueia de qualquer forma com `403`).
2. **Formulário** com: upload de `.xlsx` (`accept=".xlsx"`, validar 5 MB no cliente), campo `title`, campo `body` — reaproveitar o mesmo componente de título/corpo da tela de marketing — e, opcionalmente, os mesmos controles de deep-link (`type`/`url`/`screen`) serializados com `JSON.stringify` no campo `data`.
3. **Confirmação antes do envio** (ação em massa e irreversível): mostrar "Enviar notificação para os CPFs da planilha?".
4. **Loading + timeout de 60s+** durante a requisição (envio síncrono).
5. **Tela de resultado** com o `resumo`: destacar `sentCount` e listar/exportar `cpfsInvalidos`, `cpfsNaoEncontrados`, `cpfsInativos`, `cpfsSemToken` e `cpfsComFalhaEnvio` para o operador conferir com o relatório de origem. `cpfsComFalhaEnvio` pode virar um botão "Reenviar apenas estes" (gerar nova planilha com esses CPFs).
6. **Formato da planilha a orientar ao operador:** primeira aba; ou uma coluna com cabeçalho "CPF", ou os CPFs direto na coluna A. Com ou sem máscara — o backend normaliza (inclusive zeros à esquerda perdidos pelo Excel).

## 4. Como testar rapidamente (curl)

```bash
curl -X POST "http://localhost:3001/api/notifications/admin/situacao-cadastro" \
  -H "Authorization: Bearer $JWT_ADMIN" \
  -F "file=@cpfs_inadimplentes.xlsx" \
  -F "title=Atualização de cadastro" \
  -F "body=Sua situação mudou. Verifique seus boletos." \
  -F 'data={"type":"internal_route","screen":"Boletos"}'
```
