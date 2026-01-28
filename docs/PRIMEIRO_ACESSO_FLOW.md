# Fluxo de Primeiro Acesso com Troca de Senha Obrigatória

## Visão Geral

Este documento descreve a implementação do fluxo de primeiro acesso onde o usuário é obrigado a trocar a senha após o cadastro inicial.

## Fluxo Completo

### 1. Primeiro Acesso (Frontend → Backend)

**Endpoint**: `POST /api/associado/primeiro-acesso`

**Request Body**:
```json
{
  "cpf": "12345678901"
}
```

**Response** (sucesso):
```json
{
  "message": "Associado cadastrado com sucesso",
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "primeiroLogin": true
}
```

**O que acontece**:
1. Backend valida o CPF na API externa do SGA
2. Se válido, cria um novo usuário com:
   - Senha temporária = CPF do usuário
   - `primeiroLogin: true`
3. Gera um token JWT automaticamente
4. Retorna o token para login automático no frontend

### 2. Login Automático (Frontend)

O frontend deve:
1. Armazenar o `access_token` recebido
2. Detectar que `primeiroLogin: true`
3. Redirecionar para a tela de troca de senha

### 3. Verificar Status do Usuário

**Endpoint**: `GET /api/auth/me`

**Headers**:
```
Authorization: Bearer <access_token>
```

**Response**:
```json
{
  "user": {
    "id": 123,
    "name": "João Silva",
    "cpf": "12345678901",
    "email": "joao@email.com",
    "plate": "ABC1234",
    "primeiroLogin": true
  }
}
```

### 4. Troca de Senha

**Endpoint**: `PATCH /api/associado/password`

**Headers**:
```
Authorization: Bearer <access_token>
```

**Request Body**:
```json
{
  "newPassword": "minhaNovaSenha123"
}
```

**Response**:
```json
{
  "message": "Senha alterada com sucesso",
  "primeiroLogin": false
}
```

**O que acontece**:
1. Backend valida que a senha tem no mínimo 6 caracteres
2. Atualiza a senha do usuário
3. **Define `primeiroLogin: false`** no banco de dados
4. Retorna sucesso

### 5. Acesso às Rotas Protegidas

Após trocar a senha, o usuário pode acessar normalmente todas as rotas da aplicação.

## Segurança com PrimeiroLoginGuard

### O que é?

O `PrimeiroLoginGuard` é um guard opcional que bloqueia o acesso a rotas protegidas para usuários que ainda não trocaram a senha (`primeiroLogin: true`).

### Como usar?

```typescript
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrimeiroLoginGuard } from '../auth/primeiro-login.guard';

@Controller('veiculos')
@UseGuards(JwtAuthGuard, PrimeiroLoginGuard) // Adicionar ambos os guards
export class VeiculosController {
  // Rotas protegidas
}
```

### Rotas que NÃO devem ter o PrimeiroLoginGuard

- `POST /auth/login` - Login padrão
- `POST /auth/register` - Registro manual
- `POST /associado/primeiro-acesso` - Cadastro inicial
- `PATCH /associado/password` - **IMPORTANTE**: Precisa estar acessível para usuários com `primeiroLogin: true`
- `GET /auth/me` - Verificação de perfil

### Exemplo de Resposta de Erro

Se um usuário com `primeiroLogin: true` tentar acessar uma rota protegida:

```json
{
  "statusCode": 403,
  "message": "É necessário trocar a senha antes de acessar outras funcionalidades",
  "primeiroLogin": true
}
```

O frontend pode usar o campo `primeiroLogin: true` para redirecionar automaticamente para a tela de troca de senha.

## Campos do Schema Prisma

```prisma
model User {
  id            Int       @id @default(autoincrement())
  name          String
  cpf           String    @unique
  email         String    @unique
  passwordHash  String
  primeiroLogin Boolean   @default(false)
  // ... outros campos
}
```

## Arquivos Modificados

### 1. `src/associado/associado.service.ts`

**Método `primeiroAcesso`**:
- ✅ Retorna token JWT para login automático
- ✅ Retorna `primeiroLogin: true`

**Método `changePassword`**:
- ✅ Valida senha mínima de 6 caracteres
- ✅ Define `primeiroLogin: false` após troca
- ✅ Retorna `primeiroLogin: false` na resposta

### 2. `src/auth/auth.service.ts`

**Método `getUserWithPlate`**:
- ✅ Retorna o campo `primeiroLogin` no select

### 3. `src/auth/dto/register.dto.ts`

- ✅ Já possui o campo `primeiroLogin?: boolean`

### 4. `src/auth/primeiro-login.guard.ts` (NOVO)

- ✅ Guard criado para bloquear acesso a rotas protegidas
- ✅ Busca status atual do usuário no banco de dados
- ✅ Retorna erro 403 se `primeiroLogin: true`

### 5. `src/auth/auth.module.ts`

- ✅ Exporta o `PrimeiroLoginGuard` para uso em outros módulos

## Teste Manual

### 1. Criar Usuário no Primeiro Acesso

```bash
curl -X POST http://localhost:3000/api/associado/primeiro-acesso \
  -H "Content-Type: application/json" \
  -d '{"cpf": "12345678901"}'
```

Deve retornar um token JWT.

### 2. Verificar Perfil

```bash
curl -X GET http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer <TOKEN>"
```

Deve retornar `primeiroLogin: true`.

### 3. Tentar Acessar Rota Protegida (se o guard estiver aplicado)

```bash
curl -X GET http://localhost:3000/api/veiculos \
  -H "Authorization: Bearer <TOKEN>"
```

Deve retornar erro 403 se o `PrimeiroLoginGuard` estiver aplicado.

### 4. Trocar Senha

```bash
curl -X PATCH http://localhost:3000/api/associado/password \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"newPassword": "novaSenha123"}'
```

Deve retornar sucesso e `primeiroLogin: false`.

### 5. Fazer Login com Nova Senha

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"cpf": "12345678901", "password": "novaSenha123"}'
```

Deve retornar um novo token.

### 6. Verificar Perfil Novamente

```bash
curl -X GET http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer <NOVO_TOKEN>"
```

Deve retornar `primeiroLogin: false`.

### 7. Acessar Rota Protegida

Agora deve funcionar normalmente.

## Aplicação do Guard (Opcional)

Para aplicar o `PrimeiroLoginGuard` em controllers específicos:

### Exemplo: Veículos Controller

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrimeiroLoginGuard } from '../auth/primeiro-login.guard';

@Controller('veiculos')
@UseGuards(JwtAuthGuard, PrimeiroLoginGuard)
export class VeiculosController {
  @Get()
  findAll() {
    // Usuários com primeiroLogin: true não podem acessar
  }
}
```

### Exemplo: Economia Controller

```typescript
@Controller('economia')
@UseGuards(JwtAuthGuard, PrimeiroLoginGuard)
export class EconomiaController {
  // Rotas protegidas
}
```

## Observações Importantes

1. **Segurança**: A senha temporária (CPF) nunca é retornada nas respostas da API
2. **Token JWT**: O token gerado no primeiro acesso permite login imediato
3. **Validação**: A senha deve ter no mínimo 6 caracteres
4. **Status em Tempo Real**: O `PrimeiroLoginGuard` consulta o banco de dados para verificar o status atual
5. **Rota de Senha**: A rota `PATCH /associado/password` **NÃO** deve ter o `PrimeiroLoginGuard`

## Próximos Passos

1. ✅ Implementação backend completa
2. ⏳ Implementação frontend (tela de troca de senha)
3. ⏳ Aplicar o `PrimeiroLoginGuard` em controllers específicos
4. ⏳ Testes end-to-end
5. ⏳ Adicionar logs de auditoria para trocas de senha

## Suporte

Em caso de dúvidas ou problemas, consulte este documento ou revise os arquivos modificados listados acima.
