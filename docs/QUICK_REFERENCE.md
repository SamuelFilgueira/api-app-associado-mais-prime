# Quick Reference - Primeiro Acesso Flow

## 🚀 Endpoints Principais

### 1. Primeiro Acesso
```http
POST /api/associado/primeiro-acesso
Content-Type: application/json

{
  "cpf": "12345678901"
}
```

**Response:**
```json
{
  "message": "Associado cadastrado com sucesso",
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "primeiroLogin": true
}
```

### 2. Verificar Perfil
```http
GET /api/auth/me
Authorization: Bearer <token>
```

**Response:**
```json
{
  "user": {
    "id": 1,
    "name": "João Silva",
    "cpf": "12345678901",
    "email": "joao@email.com",
    "primeiroLogin": true
  }
}
```

### 3. Trocar Senha
```http
PATCH /api/associado/password
Authorization: Bearer <token>
Content-Type: application/json

{
  "newPassword": "minhaNovaSenh123"
}
```

**Response:**
```json
{
  "message": "Senha alterada com sucesso",
  "primeiroLogin": false
}
```

## 🔐 PrimeiroLoginGuard

### Aplicar no Controller
```typescript
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrimeiroLoginGuard } from '../auth/primeiro-login.guard';

@Controller('economia')
@UseGuards(JwtAuthGuard, PrimeiroLoginGuard)
export class EconomiaController {
  // Rotas bloqueadas para primeiroLogin: true
}
```

### Erro Quando Bloqueado
```json
{
  "statusCode": 403,
  "message": "É necessário trocar a senha antes de acessar outras funcionalidades",
  "primeiroLogin": true
}
```

## ✅ Controllers Recomendados para o Guard

```typescript
// ✅ APLICAR EM:
@UseGuards(JwtAuthGuard, PrimeiroLoginGuard)
- EconomiaController
- DocumentosController
- OficinaController
- PostosController
- RastreamentoController
- CartaoController

// ❌ NÃO APLICAR EM:
@UseGuards(JwtAuthGuard) // Apenas JwtAuthGuard
- AssociadoController (rota password)
- AuthController
```

## 📋 Fluxo Frontend

```javascript
// 1. Primeiro Acesso
const response = await fetch('/api/associado/primeiro-acesso', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ cpf: '12345678901' })
});

const { access_token, primeiroLogin } = await response.json();

// 2. Salvar token
localStorage.setItem('token', access_token);

// 3. Redirecionar se primeiro login
if (primeiroLogin) {
  navigate('/trocar-senha');
}

// 4. Trocar senha
const passwordResponse = await fetch('/api/associado/password', {
  method: 'PATCH',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ newPassword: 'novaSenha123' })
});

// 5. Após sucesso, redirecionar para home
navigate('/home');
```

## 🧪 Testes Rápidos

### Bash/cURL
```bash
# 1. Primeiro acesso
curl -X POST http://localhost:3000/api/associado/primeiro-acesso \
  -H "Content-Type: application/json" \
  -d '{"cpf":"12345678901"}'

# 2. Verificar perfil
curl -X GET http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer <TOKEN>"

# 3. Trocar senha
curl -X PATCH http://localhost:3000/api/associado/password \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"newPassword":"novaSenha123"}'

# 4. Login com nova senha
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"cpf":"12345678901","password":"novaSenha123"}'
```

## 📁 Arquivos Modificados

```
✅ src/associado/associado.service.ts
✅ src/auth/auth.service.ts
✅ src/associado/associado.controller.ts
✅ src/auth/auth.module.ts
⭐ src/auth/primeiro-login.guard.ts (NOVO)
📄 docs/PRIMEIRO_ACESSO_FLOW.md (NOVO)
📄 docs/PRIMEIRO_LOGIN_GUARD_USAGE.md (NOVO)
📄 docs/IMPLEMENTATION_SUMMARY.md (NOVO)
```

## 🎯 Estado do Usuário

| Estado | primeiroLogin | Pode Acessar Rotas Protegidas? | Ação Necessária |
|--------|---------------|--------------------------------|-----------------|
| Recém cadastrado | `true` | ❌ Não (se guard aplicado) | Trocar senha |
| Senha trocada | `false` | ✅ Sim | Nenhuma |

## ⚡ Validações

### Senha
- ✅ Mínimo 6 caracteres
- ✅ Hasheada com bcrypt
- ✅ Nunca retornada na API

### CPF
- ✅ Validado na API externa (SGA)
- ✅ Único no banco de dados
- ✅ Usado como senha temporária

## 📚 Documentação Completa

- [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) - Resumo completo
- [PRIMEIRO_ACESSO_FLOW.md](PRIMEIRO_ACESSO_FLOW.md) - Fluxo detalhado
- [PRIMEIRO_LOGIN_GUARD_USAGE.md](PRIMEIRO_LOGIN_GUARD_USAGE.md) - Guia do guard

---

**Versão**: 1.0.0  
**Status**: ✅ Pronto para uso
