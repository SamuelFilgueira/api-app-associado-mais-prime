# Upload de Foto de Perfil - Documentação

## Funcionalidade Implementada

Foi implementado um sistema completo de upload e processamento de fotos de perfil para usuários.

## Alterações no Banco de Dados

### Schema Prisma
- Adicionado campo `profilePhotoUrl` (opcional) no modelo `user`
- O campo armazena o caminho relativo da foto de perfil

**Importante**: Para aplicar as alterações no banco de dados, execute:
```bash
npx prisma migrate dev --name add_profile_photo_to_user
```

## Como Usar

### Endpoint
```
PATCH /api/associado/:id
```

### Formato da Requisição
A requisição deve ser enviada como `multipart/form-data` (não JSON).

### Parâmetros

#### Body (multipart/form-data)
- `name` (opcional): Nome do usuário
- `email` (opcional): Email do usuário
- `cpf` (opcional): CPF do usuário
- `cep` (opcional): CEP do usuário
- `address` (opcional): Endereço do usuário
- `profilePhoto` (opcional): Arquivo de imagem (campo de upload)

#### URL Params
- `id`: ID do associado

### Exemplo com React Native / Expo

```javascript
import * as ImagePicker from 'expo-image-picker';

// Selecionar imagem
const pickImage = async () => {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.8,
  });

  if (!result.canceled) {
    await uploadProfilePhoto(result.assets[0].uri);
  }
};

// Upload da foto
const uploadProfilePhoto = async (imageUri) => {
  const formData = new FormData();
  
  // Adiciona a imagem
  formData.append('profilePhoto', {
    uri: imageUri,
    type: 'image/jpeg',
    name: 'profile.jpg',
  });
  
  // Adiciona outros campos (opcional)
  formData.append('name', 'João Silva');
  
  try {
    const response = await fetch(`http://your-api.com/api/associado/${userId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'multipart/form-data',
        'Authorization': `Bearer ${token}`,
      },
      body: formData,
    });
    
    const data = await response.json();
    console.log('Upload success:', data);
  } catch (error) {
    console.error('Upload error:', error);
  }
};
```

### Exemplo com cURL

```bash
curl -X PATCH http://localhost:3000/api/associado/1 \
  -F "profilePhoto=@/path/to/photo.jpg" \
  -F "name=João Silva" \
  -F "email=joao@example.com"
```

## Processamento de Imagem

As imagens são processadas automaticamente com as seguintes otimizações:

1. **Redimensionamento**: Máximo de 800x800px mantendo proporção
2. **Compressão**: JPEG com qualidade 85%
3. **Formato**: Convertido para JPEG progressivo
4. **Nomenclatura**: Nome único baseado em timestamp e string aleatória

## Armazenamento

- **Pasta**: `uploads/profile-photos/`
- **Formato do nome**: `profile-{timestamp}-{random}.jpg`
- **Acesso**: As imagens são servidas estaticamente em `/uploads/profile-photos/{filename}`

### Acessar Foto de Perfil

Se o `profilePhotoUrl` retornado for `"uploads/profile-photos/profile-1234567890-abc123.jpg"`, a URL completa será:

```
http://your-api.com/uploads/profile-photos/profile-1234567890-abc123.jpg
```

## Comportamento

1. **Upload de nova foto**: 
   - A foto antiga é deletada automaticamente
   - A nova foto é processada e salva
   - O caminho é atualizado no banco de dados

2. **Atualização sem foto**: 
   - Se não enviar o campo `profilePhoto`, apenas os outros campos são atualizados
   - A foto atual permanece inalterada

3. **Erro no upload**:
   - Se houver erro no processamento, nenhuma alteração é feita
   - A foto antiga permanece

## Segurança

- Apenas imagens são aceitas (processadas pelo Sharp)
- Tamanho limitado pelo multer (configurável)
- Fotos antigas são removidas ao fazer upload de novas
- Pasta `/uploads` está no `.gitignore`

## Dependências Instaladas

```json
{
  "sharp": "Processamento e compressão de imagens",
  "@types/multer": "Tipos TypeScript para Multer"
}
```

## Arquivos Criados/Modificados

### Criados:
- `src/common/services/file-upload.service.ts` - Serviço de upload

### Modificados:
- `prisma/schema.prisma` - Campo profilePhotoUrl no modelo user
- `src/associado/DTOs/update-associado.dto.ts` - Campo profilePhotoUrl no DTO
- `src/associado/associado.service.ts` - Lógica de upload
- `src/associado/associado.controller.ts` - Recepção de arquivo
- `src/associado/associado.module.ts` - Provider FileUploadService
- `src/main.ts` - Servir arquivos estáticos
- `.gitignore` - Pasta /uploads

## Notas Importantes

1. **Migração do Banco**: Execute a migração do Prisma antes de usar
2. **Pasta Uploads**: Será criada automaticamente no primeiro upload
3. **Git**: A pasta uploads não é versionada (está no .gitignore)
4. **Production**: Em produção, considere usar um CDN ou serviço de armazenamento (S3, Cloudinary, etc.)
