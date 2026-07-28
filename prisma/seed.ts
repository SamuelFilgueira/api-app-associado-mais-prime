/**
 * Seed mínimo para subir um banco limpo de uma nova empresa do grupo.
 *
 * Cria apenas o que a aplicação precisa para ser operável logo após
 * `prisma migrate deploy`:
 *   1. um usuário do painel administrativo (sem ele não há como entrar);
 *   2. as políticas de versão mínima do app (Android/iOS), se informadas.
 *
 * É idempotente: rodar mais de uma vez não duplica registros.
 *
 * Uso:
 *   SEED_ADMIN_EMAIL=admin@hertz.com.br \
 *   SEED_ADMIN_PASSWORD='senha-forte' \
 *   npm run prisma:seed
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function seedAdminPanelUser() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME?.trim() || 'Administrador';

  if (!email || !password) {
    console.warn(
      '[seed] SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD não definidos — usuário do painel não criado.',
    );
    return;
  }

  const existing = await prisma.adminPanelUser.findUnique({ where: { email } });

  if (existing) {
    console.log(`[seed] Usuário do painel já existe: ${email} (nada a fazer)`);
    return;
  }

  await prisma.adminPanelUser.create({
    data: {
      name,
      email,
      password: await bcrypt.hash(password, 10),
      role: 'ADMIN',
      updatedAt: new Date(),
    },
  });

  console.log(`[seed] Usuário ADMIN do painel criado: ${email}`);
}

async function seedAppVersionPolicies() {
  const androidStoreUrl = process.env.SEED_ANDROID_STORE_URL?.trim();
  const iosStoreUrl = process.env.SEED_IOS_STORE_URL?.trim();
  const minVersion = process.env.SEED_MIN_APP_VERSION?.trim() || '1.0.0';

  const policies = [
    { platform: 'android', storeUrl: androidStoreUrl },
    { platform: 'ios', storeUrl: iosStoreUrl },
  ].filter((policy) => policy.storeUrl);

  if (policies.length === 0) {
    console.warn(
      '[seed] SEED_ANDROID_STORE_URL/SEED_IOS_STORE_URL não definidos — políticas de versão não criadas.',
    );
    return;
  }

  for (const policy of policies) {
    const existing = await prisma.appVersionPolicy.findFirst({
      where: { platform: policy.platform, isActive: true },
    });

    if (existing) {
      console.log(
        `[seed] Política de versão ativa já existe para ${policy.platform} (nada a fazer)`,
      );
      continue;
    }

    await prisma.appVersionPolicy.create({
      data: {
        platform: policy.platform,
        minSupportedVersion: minVersion,
        storeUrl: policy.storeUrl,
        forceUpdateEnabled: false,
        isActive: true,
        createdBy: 'seed',
        notes: 'Criada pelo seed inicial da base',
        updatedAt: new Date(),
      },
    });

    console.log(
      `[seed] Política de versão criada para ${policy.platform} (mínima: ${minVersion})`,
    );
  }
}

async function main() {
  await seedAdminPanelUser();
  await seedAppVersionPolicies();
}

main()
  .catch((error) => {
    console.error('[seed] Falhou:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
