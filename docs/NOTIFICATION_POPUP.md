# Pop-up de Notificação - Documentação

## Visão Geral

Sistema de pop-up controlado pelo backend que aparece na tela inicial do app. Permite criar/atualizar/desativar pop-ups sem precisar publicar nova versão do app.

---

## Autenticação

**GET /notifications/popup** requer apenas token JWT do usuário (qualquer role).

**PUT /notifications/popup** e **PUT /notifications/popup/:id** requerem token JWT de um usuário com role `ADMIN` no app **e** permissão `MARKETING` ou `ADMIN` no painel administrativo.

**Header obrigatório em todos os endpoints:**
```
Authorization: Bearer <seu_token_jwt>
```

---

## Endpoints

### 1. Buscar Pop-up Ativo (app)

**GET** `/notifications/popup`

Retorna o pop-up mais recente com `active: true`, ou `null` se não houver.

**Exemplo de Request:**
```bash
GET /notifications/popup
Authorization: Bearer eyJhbGc...
```

**Response (200 OK) — com pop-up ativo:**
```json
{
  "id": 1,
  "imageUrl": "https://exemplo.com/banners/promocao-julho.png",
  "linkUrl": "https://exemplo.com/oferta",
  "linkLabel": "Ver oferta",
  "active": true,
  "userId": 1,
  "createdAt": "2026-07-20T12:00:00.000Z",
  "updatedAt": "2026-07-20T12:00:00.000Z"
}
```

**Response (200 OK) — sem pop-up ativo:**
```json
null
```

### 2. Criar Pop-up (admin)

**PUT** `/notifications/popup`

Cria um novo pop-up. Se `active: true`, este será exibido no app (apenas um pop-up ativo por vez, o mais recente).

> **Formato:** multipart/form-data (upload de imagem + campos de texto)

| Campo       | Tipo           | Obrigatório | Descrição                                     |
|-------------|----------------|-------------|-----------------------------------------------|
| `image`     | file (binary)  | não         | Arquivo de imagem do pop-up (800x400px, max 500KB) |
| `imageUrl`  | string         | não         | Alternativa à imagem: URL pública diretamente |
| `linkUrl`   | string         | não         | URL de destino ao clicar no botão             |
| `linkLabel` | string         | não         | Texto do botão (padrão: "Saiba mais")         |
| `active`    | boolean/string | não         | `true` ou `"true"` para ativar                |

> Enviando `image` (arquivo) → o backend faz upload e armazena a URL.
> Enviando `imageUrl` (string) → usa a URL diretamente (sem upload).
> Se nenhum dos dois for enviado na criação, retorna erro. Na atualização, mantém a imagem existente.

**cURL (com upload de imagem):**
```bash
curl -X PUT http://localhost:3000/notifications/popup \
  -H "Authorization: Bearer <token_admin>" \
  -F "image=@/caminho/para/banner.png" \
  -F "linkUrl=https://exemplo.com/promocao" \
  -F "linkLabel=Aproveitar" \
  -F "active=true"
```

**cURL (com URL direta, sem upload):**
```bash
curl -X PUT http://localhost:3000/notifications/popup \
  -H "Authorization: Bearer <token_admin>" \
  -F "imageUrl=https://exemplo.com/banner.png" \
  -F "linkUrl=https://exemplo.com/promocao" \
  -F "linkLabel=Aproveitar" \
  -F "active=true"
```

**Response (200 OK):**
```json
{
  "id": 1,
  "imageUrl": "https://exemplo.com/banner.png",
  "linkUrl": "https://exemplo.com/promocao",
  "linkLabel": "Aproveitar",
  "active": true,
  "userId": 1,
  "createdAt": "2026-07-20T12:00:00.000Z",
  "updatedAt": "2026-07-20T12:00:00.000Z"
}
```

### 3. Atualizar Pop-up (admin)

**PUT** `/notifications/popup/:id`

Atualiza um pop-up existente. Para desativar, envie `active: false`.

**cURL (desativar pop-up):**
```bash
curl -X PUT http://localhost:3000/notifications/popup/1 \
  -H "Authorization: Bearer <token_admin>" \
  -F "active=false"
```

**cURL (trocar imagem):**
```bash
curl -X PUT http://localhost:3000/notifications/popup/1 \
  -H "Authorization: Bearer <token_admin>" \
  -F "image=@/caminho/para/novo-banner.png" \
  -F "active=true"
```

**Response (200 OK):**
```json
{
  "id": 1,
  "imageUrl": "https://exemplo.com/banner.png",
  "linkUrl": "https://exemplo.com/promocao",
  "linkLabel": "Aproveitar",
  "active": false,
  "userId": 1,
  "createdAt": "2026-07-20T12:00:00.000Z",
  "updatedAt": "2026-07-20T12:30:00.000Z"
}
```

---

## Regras de Negócio

1. **Apenas um pop-up ativo por vez:** o GET retorna o mais recente com `active: true`
2. **Imagem obrigatória:** sem imagem (arquivo `image` ou campo `imageUrl`) o pop-up não pode ser marcado como `active` (o backend força `active: false`)
3. **HTTPS obrigatório:** todas as URLs de imagem e link devem usar HTTPS
4. **Link opcional:** se `linkUrl` não for enviado, o botão não aparece (apenas imagem + fechar)

---

## Guia de Integração Frontend (React Native / Expo)

### Tipo de dados

```typescript
interface NotificationPopup {
  id: number;
  imageUrl: string;
  linkUrl?: string | null;
  linkLabel?: string | null;
  active: boolean;
  userId: number;
  createdAt: string;
  updatedAt: string;
}
```

### Função de busca

```typescript
const API_BASE = 'https://api.exemplo.com';

async function fetchPopup(token: string): Promise<NotificationPopup | null> {
  try {
    const response = await fetch(`${API_BASE}/notifications/popup`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) return null;

    const data: NotificationPopup | null = await response.json();
    return data?.active ? data : null;
  } catch {
    return null;
  }
}
```

### Exemplo de uso com Modal (React Native)

```typescript
import { useEffect, useState } from 'react';
import { Modal, View, Image, TouchableOpacity, Text, Linking } from 'react-native';

function HomeScreen() {
  const [popup, setPopup] = useState<NotificationPopup | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    (async () => {
      const data = await fetchPopup('seu_token_jwt');
      if (data) {
        setPopup(data);
        setVisible(true);
      }
    })();
  }, []);

  const handleLinkPress = () => {
    if (popup?.linkUrl) {
      Linking.openURL(popup.linkUrl);
    }
    setVisible(false);
  };

  if (!popup) return null;

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: '90%', maxWidth: 400, backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden' }}>
          <Image
            source={{ uri: popup.imageUrl }}
            style={{ width: '100%', height: 200 }}
            resizeMode="contain"
          />

          {popup.linkUrl && (
            <TouchableOpacity onPress={handleLinkPress} style={{ padding: 16, alignItems: 'center' }}>
              <Text style={{ color: '#1a73e8', fontWeight: '600', fontSize: 16 }}>
                {popup.linkLabel || 'Saiba mais'}
              </Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity onPress={() => setVisible(false)} style={{ padding: 12, alignItems: 'center' }}>
            <Text style={{ color: '#666', fontSize: 14 }}>Fechar</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
```

---

## Testes no Postman

### Variáveis de ambiente recomendadas

| Variável    | Valor                        |
|-------------|------------------------------|
| `base_url`  | `http://localhost:3000`      |
| `token`     | `<seu_token_jwt_do_usuario>` |
| `token_admin` | `<token_de_admin_com_role_MARKETING>` |

### Coleção Postman (importar como raw)

```json
{
  "info": {
    "name": "Notification Popup",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "GET - Buscar pop-up ativo",
      "request": {
        "method": "GET",
        "header": [
          { "key": "Authorization", "value": "Bearer {{token}}" }
        ],
        "url": {
          "raw": "{{base_url}}/notifications/popup",
          "host": ["{{base_url}}"],
          "path": ["notifications", "popup"]
        }
      }
    },
    {
      "name": "PUT - Criar pop-up (com upload)",
      "request": {
        "method": "PUT",
        "header": [
          { "key": "Authorization", "value": "Bearer {{token_admin}}" }
        ],
        "body": {
          "mode": "formdata",
          "formdata": [
            { "key": "image", "type": "file", "src": "/caminho/para/banner.png" },
            { "key": "linkUrl", "value": "https://exemplo.com/promocao" },
            { "key": "linkLabel", "value": "Ver oferta" },
            { "key": "active", "value": "true" }
          ]
        },
        "url": {
          "raw": "{{base_url}}/notifications/popup",
          "host": ["{{base_url}}"],
          "path": ["notifications", "popup"]
        }
      }
    },
    {
      "name": "PUT - Criar pop-up (com URL direta)",
      "request": {
        "method": "PUT",
        "header": [
          { "key": "Authorization", "value": "Bearer {{token_admin}}" }
        ],
        "body": {
          "mode": "formdata",
          "formdata": [
            { "key": "imageUrl", "value": "https://exemplo.com/banner.png" },
            { "key": "linkUrl", "value": "https://exemplo.com/promocao" },
            { "key": "linkLabel", "value": "Ver oferta" },
            { "key": "active", "value": "true" }
          ]
        },
        "url": {
          "raw": "{{base_url}}/notifications/popup",
          "host": ["{{base_url}}"],
          "path": ["notifications", "popup"]
        }
      }
    },
    {
      "name": "PUT - Desativar pop-up (por ID)",
      "request": {
        "method": "PUT",
        "header": [
          { "key": "Authorization", "value": "Bearer {{token_admin}}" }
        ],
        "body": {
          "mode": "formdata",
          "formdata": [
            { "key": "active", "value": "false" }
          ]
        },
        "url": {
          "raw": "{{base_url}}/notifications/popup/1",
          "host": ["{{base_url}}"],
          "path": ["notifications", "popup", "1"]
        }
      }
    },
    {
      "name": "PUT - Atualizar imagem e ativar",
      "request": {
        "method": "PUT",
        "header": [
          { "key": "Authorization", "value": "Bearer {{token_admin}}" }
        ],
        "body": {
          "mode": "formdata",
          "formdata": [
            { "key": "image", "type": "file", "src": "/caminho/para/novo-banner.png" },
            { "key": "linkLabel", "value": "Aproveitar" },
            { "key": "active", "value": "true" }
          ]
        },
        "url": {
          "raw": "{{base_url}}/notifications/popup/1",
          "host": ["{{base_url}}"],
          "path": ["notifications", "popup", "1"]
        }
      }
    }
  ]
}
```

---

## Fluxo de Teste Completo

1. **Criar pop-up** via `PUT /notifications/popup` com `active: true`
2. **Verificar** via `GET /notifications/popup` → deve retornar os dados do pop-up
3. **Testar no app** → o pop-up deve aparecer na Home
4. **Desativar** via `PUT /notifications/popup/1` com `active: false`
5. **Verificar** via `GET /notifications/popup` → deve retornar `null`
6. **Reabrir app** → pop-up **não** deve mais aparecer

---

## Recomendações de Imagem

| Propriedade      | Valor                    |
|------------------|--------------------------|
| Largura          | **800px**                |
| Altura           | **400px**                |
| Proporção        | **2:1**                  |
| Formato          | PNG ou WebP (comprimido) |
| Tamanho máximo   | **500 KB**               |
| Protocolo        | HTTPS obrigatório        |
