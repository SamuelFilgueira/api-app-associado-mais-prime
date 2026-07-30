# Alterar a própria senha — integração no frontend do painel administrativo

> **Instruções para implementação assistida por IA.** Este documento é
> autocontido: contém o contrato exato do backend, as regras de UX, o mapa de
> erros e os critérios de aceite. Siga-o na ordem. Não invente campos, rotas ou
> comportamentos que não estejam descritos aqui.

## Contexto

O backend (NestJS) ganhou um endpoint **aditivo** para que o usuário logado no
painel administrativo altere a **própria** senha. Ele é diferente do
`PATCH /api/admin-panel/users/:id` (CRUD de gestão, que reseta a senha de
**terceiros** sem pedir a senha atual). Não misture os dois fluxos na UI.

Princípios de segurança que a UI deve preservar:

1. O alvo é sempre o dono do token — o backend ignora qualquer id enviado;
   **não** envie id de usuário no body nem na rota.
2. A senha atual é obrigatória — um token vazado não basta para trocar a senha.
3. O endpoint só aceita tokens emitidos pelo login do painel
   (`POST /api/admin-panel/auth/login`). Tokens do app móvel recebem 403.

---

## 1. Contrato do endpoint

```
PATCH {API_BASE_URL}/api/admin-panel/auth/me/password
Authorization: Bearer <access_token do login do painel>
Content-Type: application/json
```

### Request body

```json
{
  "currentPassword": "senha-vigente",
  "newPassword": "senha-nova"
}
```

| Campo | Tipo | Regras |
|---|---|---|
| `currentPassword` | string | obrigatório, mínimo 6 caracteres |
| `newPassword` | string | obrigatório, mínimo 6 caracteres, diferente da atual |

### Resposta de sucesso — `200`

```json
{ "success": true, "message": "Senha alterada com sucesso" }
```

O token JWT em uso **continua válido** após a troca (o backend não revoga
tokens). Não é necessário reautenticar.

### Erros

| Status | Quando ocorre | `message` no body | Ação da UI |
|---|---|---|---|
| `401` | senha atual errada | `"Senha atual incorreta"` | erro inline no campo "Senha atual"; **NÃO deslogar** |
| `401` | token ausente/expirado | outra mensagem qualquer | fluxo padrão de sessão expirada (logout + redirect login) |
| `400` | nova senha igual à atual | `"A nova senha deve ser diferente da senha atual"` | erro inline no campo "Nova senha" |
| `422` | validação (ex.: < 6 caracteres) | array de mensagens do ValidationPipe | não deve ocorrer se a validação local estiver correta; exibir a primeira mensagem como fallback |
| `403` | token que não é do painel | `"Recurso exclusivo de usuários do painel administrativo"` | toast de erro genérico |
| `404` | usuário do token foi removido | `"Usuário administrativo não encontrado"` | deslogar (a conta não existe mais) |

> ⚠️ **Interceptor global de 401.** Se o projeto tem um interceptor axios/fetch
> que desloga em qualquer 401, este endpoint quebra a UX: errar a senha atual
> derrubaria a sessão. Diferencie pelo corpo da resposta — 401 com
> `message === "Senha atual incorreta"` é erro de formulário e deve ser
> propagado para o componente, nunca tratado como sessão expirada.

---

## 2. Onde a funcionalidade vive na UI

- Entrada: item **"Alterar senha"** no menu do usuário (avatar/nome no canto da
  navegação) — disponível para **todos** os perfis do painel (REVISTORIA,
  EVENTOS, MARKETING, COBRANCA, ADMIN).
- Forma: modal (preferido) ou página dedicada tipo `/perfil/alterar-senha`,
  seguindo o padrão de navegação já existente no projeto.
- **Não** adicionar esta ação na tela de gestão de usuários — lá permanece o
  fluxo administrativo de reset de terceiros.

---

## 3. Formulário

Três campos, nesta ordem, todos `type="password"`:

| Campo | `autocomplete` | Validação local |
|---|---|---|
| Senha atual | `current-password` | obrigatório, ≥ 6 caracteres |
| Nova senha | `new-password` | obrigatório, ≥ 6 caracteres, **≠ senha atual** |
| Confirmar nova senha | `new-password` | igual à "Nova senha" |

Regras de comportamento:

- Validação local espelha a do backend e roda antes do submit (o usuário não
  deve descobrir regras via erro de rede). Mensagens em português.
- Botão de submit desabilitado enquanto o formulário for inválido **ou** houver
  requisição em andamento (mostrar spinner no botão durante o envio).
- Cada campo com botão de mostrar/ocultar senha (ícone de olho).
- `confirmPassword` **não** é enviado ao backend — é validação puramente local.
- Nunca logar os valores dos campos (console, analytics, error tracking).

---

## 4. Implementação de referência

Adapte aos padrões do projeto (client HTTP, biblioteca de formulário, sistema de
toast). O exemplo usa axios + react-hook-form + zod por serem os mais comuns;
o que importa é o comportamento, não a biblioteca.

### 4.1 Camada de API

```typescript
// api/auth.ts (ou onde vivem as chamadas de auth do painel)
import { apiClient } from "./client"; // client que injeta o Bearer do painel

export interface ChangePasswordPayload {
  currentPassword: string;
  newPassword: string;
}

export async function changeOwnPassword(payload: ChangePasswordPayload) {
  const res = await apiClient.patch<{ success: boolean; message: string }>(
    "/api/admin-panel/auth/me/password",
    payload,
  );
  return res.data;
}
```

### 4.2 Schema de validação local

```typescript
import { z } from "zod";

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(6, "A senha atual tem no mínimo 6 caracteres"),
    newPassword: z.string().min(6, "A nova senha deve ter no mínimo 6 caracteres"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    path: ["confirmPassword"],
    message: "A confirmação não confere com a nova senha",
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    path: ["newPassword"],
    message: "A nova senha deve ser diferente da senha atual",
  });
```

### 4.3 Tratamento do submit

```typescript
async function onSubmit(values: ChangePasswordForm) {
  try {
    await changeOwnPassword({
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
    });
    toast.success("Senha alterada com sucesso");
    form.reset();
    closeModal();
  } catch (err) {
    const status = err?.response?.status;
    const message = err?.response?.data?.message;

    if (status === 401 && message === "Senha atual incorreta") {
      form.setError("currentPassword", { message: "Senha atual incorreta" });
      return; // NÃO deslogar
    }
    if (status === 400) {
      form.setError("newPassword", {
        message: message ?? "Nova senha inválida",
      });
      return;
    }
    if (status === 404) {
      logout(); // conta removida — sessão não faz mais sentido
      return;
    }
    // 403, 422 e demais: toast genérico com a mensagem do backend se houver
    toast.error(
      Array.isArray(message) ? message[0] : (message ?? "Não foi possível alterar a senha"),
    );
  }
}
```

### 4.4 Ajuste no interceptor global (se existir)

```typescript
// Antes de tratar 401 como sessão expirada:
const isPasswordCheckFailure =
  error.response?.status === 401 &&
  error.config?.url?.includes("/admin-panel/auth/me/password") &&
  error.response?.data?.message === "Senha atual incorreta";

if (isPasswordCheckFailure) {
  return Promise.reject(error); // deixa o formulário tratar
}
// ...fluxo normal de logout
```

---

## 5. Critérios de aceite (testar manualmente antes de concluir)

1. ✅ Usuário de qualquer perfil do painel (não só ADMIN) consegue abrir o
   formulário e trocar a própria senha.
2. ✅ Com a senha atual errada: erro inline em "Senha atual", sessão intacta
   (usuário continua logado e na mesma tela).
3. ✅ Nova senha igual à atual: bloqueado localmente antes do submit; se chegar
   ao backend, o 400 aparece como erro inline em "Nova senha".
4. ✅ Confirmação diferente da nova senha: bloqueado localmente.
5. ✅ Senha com menos de 6 caracteres: bloqueado localmente.
6. ✅ Sucesso: toast, campos limpos, modal fechado, usuário segue logado.
7. ✅ Após a troca, o login com a senha antiga falha e com a nova funciona.
8. ✅ Duplo clique no submit não dispara duas requisições (botão desabilitado
   durante o envio).
9. ✅ Nenhuma senha aparece em console, network logs custom ou analytics.

### Smoke test via curl (sem UI)

```bash
# 1. login no painel
curl -s -X POST "$API/api/admin-panel/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@painel.com","password":"senha-atual"}'

# 2. trocar a senha (usar o access_token da resposta acima)
curl -s -X PATCH "$API/api/admin-panel/auth/me/password" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"senha-atual","newPassword":"senha-nova-123"}'

# 3. conferir os erros
#    - currentPassword errada  -> 401 "Senha atual incorreta"
#    - newPassword igual       -> 400
#    - newPassword com 3 chars -> 422
```

---

## 6. Fora de escopo (não implementar)

- Forçar logout após a troca (o token permanece válido por design).
- "Esqueci minha senha" / reset por e-mail — não existe endpoint para isso;
  o reset de quem esqueceu a senha é feito por um ADMIN via
  `PATCH /api/admin-panel/users/:id`.
- Medidor de força de senha, expiração de senha, histórico de senhas — política
  atual do backend é apenas "mínimo 6 caracteres e diferente da atual".
