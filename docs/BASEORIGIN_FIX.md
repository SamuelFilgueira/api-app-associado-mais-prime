# Correção do BaseOrigin - Documento de Validação

## Problema Identificado
O `baseOrigin` estava retornando como `UNKNOWN` porque:
1. **JWT Strategy** retornava `UserBaseOrigin` mas **BaseContextService** esperava `baseOrigin`
2. **Auth.service.register()** não salvava o `baseOrigin` no banco de dados
3. Faltava logging detalhado para debugar o fluxo

## Correções Implementadas

### 1. src/auth/jwt.strategy.ts
```diff
- UserBaseOrigin: payload.baseOrigin as UserBaseOrigin,
+ baseOrigin: payload.baseOrigin as UserBaseOrigin,
```
**Impacto**: Agora a propriedade é retornada com o nome correto no objeto de usuário autenticado

---

### 2. src/shared/base-context.service.ts
- **getBaseOrigin()**: 
  - Remove fallback para 'UNKNOWN'
  - Lança erro explícito com contexto detalhado
  - Logs com timestamps e dados disponíveis
  
- **getToken()**: 
  - Valida se variáveis de ambiente existem
  - Mensagens de erro específicas por base
  - Logs de sucesso

**Impacto**: Erros claros ao invés de valores silenciosos

---

### 3. src/auth/auth.service.ts
```diff
const user = await this.prisma.user.create({
  data: {
    // ... outros campos
+   baseOrigin: data.baseOrigin,
    updatedAt: new Date(),
  },
});
```
**Impacto**: O `baseOrigin` agora é persistido no banco de dados

---

## Fluxo de teste

### 1️⃣ Registrar um novo associado
```bash
POST /associado/registrar
Content-Type: application/json

{
  "cpf": "00000000000",
  "name": "Test User",
  "email": "test@email.com",
  "password": "password123"
}
```

✅ **Esperado**: Retorna `access_token` com baseOrigin válido (MAIS_PRIME ou MAIS_PRIME_RS)

---

### 2️⃣ Validar dados salvos no banco
```sql
SELECT id, cpf, name, baseOrigin FROM `user` WHERE cpf = '00000000000';
```

✅ **Esperado**: `baseOrigin` NÃO é NULL (deve ser MAIS_PRIME ou MAIS_PRIME_RS)

---

### 3️⃣ Fazer login e validar JWT
```bash
POST /auth/login
Content-Type: application/json

{
  "username": "00000000000",
  "password": "00000000000"
}
```

Decodificar o JWT retornado (jwt.io):
```json
{
  "sub": 1,
  "cpf": "00000000000",
  "username": "Test User",
  "role": "USER",
  "baseOrigin": "MAIS_PRIME",  // ← Deve estar aqui, NÃO como "UserBaseOrigin"
  "iat": 1680000000,
  "exp": 1680086400
}
```

✅ **Esperado**: `baseOrigin` está presente e com valor válido

---

### 4️⃣ Chamar endpoint que usa BaseContextService
```bash
GET /beneficios/saldo  # ou qualquer endpoint que use getBaseOrigin()
Authorization: Bearer <token_jwt>
```

**Observar logs do console**:
```
[BaseContextService] Base de origem obtida: MAIS_PRIME
[BaseContextService] Token obtido com sucesso para base: MAIS_PRIME
```

✅ **Esperado**: Logs mostram valores válidos, sem "UNKNOWN"

---

## Possíveis erros e soluções

### ❌ "Error: Base de origem não configurada"
**Causa**: Token gerado sem `baseOrigin` (usuário antigo no banco ou registro sem baseOrigin)

**Solução**:
1. Deletar usuários de teste antigos
2. Criar novo registro via `/associado/registrar`
3. Ou atualizar manualmente no banco: `UPDATE user SET baseOrigin = 'MAIS_PRIME' WHERE id = ?`

---

### ❌ "Error: Variável de ambiente SGA_TOKEN não configurada"
**Causa**: Variáveis de ambiente não estão definidas no `.env`

**Solução**:
```bash
# .env
SGA_TOKEN=seu_token_aqui
SGA_TOKEN_RS=seu_token_rs_aqui
JWT_SECRET=sua_chave_secreta
DATABASE_URL=mysql://user:pass@host:3306/db
```

---

### ❌ "baseOrigin não encontrado. Disponível: userId,email,username,role"
**Causa**: JWT foi gerado antes dessa correção

**Solução**: Fazer login novamente para gerar novo JWT com a estrutura corrigida

---

## Resumo das mudanças

| Arquivo | Alteração | Razão |
|---------|-----------|-------|
| `jwt.strategy.ts` | `UserBaseOrigin` → `baseOrigin` | Consistência de naming |
| `auth.service.ts` | Adiciona `baseOrigin` ao `create()` | Persistência no banco |
| `base-context.service.ts` | Remove fallback, melhora logs | Transparência de erros |

---

## Verificação rápida de saúde
```bash
# 1. Verificar logs de contexto
grep -r "Base de origem obtida" . # deve mostrar logs recentes

# 2. Consultar usuários sem baseOrigin
SELECT COUNT(*) FROM `user` WHERE baseOrigin IS NULL;

# 3. Testar endpoint que depende de baseOrigin
curl -H "Authorization: Bearer <token>" http://localhost:3000/beneficios/saldo
```

---

**Status**: ✅ Todas as correções aplicadas - Pronto para testes
