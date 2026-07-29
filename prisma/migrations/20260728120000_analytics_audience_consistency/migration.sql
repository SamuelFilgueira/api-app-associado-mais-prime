-- Consistência de audiência do analytics.
--
-- 1) Tira `appVersion` da unicidade de aparelhos/sessões diárias: um aparelho
--    que atualizou o app no meio do dia contava duas vezes, inflando a
--    plataforma que atualiza mais rápido nos dias de rollout.
-- 2) Cria AnalyticsInstallFirstSeen (primeira aparição de cada aparelho) com
--    backfill do histórico — habilita "instalações novas" e coortes.
--
-- Os contadores já gravados em AnalyticsSessionDaily NÃO são recalculados:
-- a série histórica permanece como foi medida; a regra nova vale das
-- próximas ingestões em diante.

-- ── 1a. Dedup de aparelhos: mantém a linha mais antiga de cada
--        (day, platform, installHash) antes de apertar o índice único.
DELETE t FROM `AnalyticsDailyUniqueInstall` t
JOIN `AnalyticsDailyUniqueInstall` k
  ON k.`day` = t.`day`
 AND k.`platform` = t.`platform`
 AND k.`installHash` = t.`installHash`
 AND k.`id` < t.`id`;

ALTER TABLE `AnalyticsDailyUniqueInstall`
  DROP INDEX `AnalyticsDailyUniqueInstall_unique_key`,
  ADD UNIQUE INDEX `AnalyticsDailyUniqueInstall_unique_key`(`day`, `platform`, `installHash`);

-- ── 1b. Dedup de sessões, mesma regra.
DELETE t FROM `AnalyticsDailyUniqueSession` t
JOIN `AnalyticsDailyUniqueSession` k
  ON k.`day` = t.`day`
 AND k.`platform` = t.`platform`
 AND k.`sessionHash` = t.`sessionHash`
 AND k.`id` < t.`id`;

ALTER TABLE `AnalyticsDailyUniqueSession`
  DROP INDEX `AnalyticsDailyUniqueSession_unique_key`,
  ADD UNIQUE INDEX `AnalyticsDailyUniqueSession_unique_key`(`day`, `platform`, `sessionHash`);

-- ── 2a. Primeira aparição de cada aparelho.
CREATE TABLE `AnalyticsInstallFirstSeen` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `installHash` VARCHAR(64) NOT NULL,
    `platform` VARCHAR(10) NOT NULL,
    `appVersion` VARCHAR(20) NOT NULL,
    `firstSeenDay` DATE NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AnalyticsInstallFirstSeen_installHash_key`(`installHash`),
    INDEX `AnalyticsInstallFirstSeen_firstSeenDay_idx`(`firstSeenDay`),
    INDEX `AnalyticsInstallFirstSeen_platform_idx`(`platform`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── 2b. Backfill: a linha mais antiga de cada hash vence (ORDER BY day +
--        INSERT IGNORE contra o índice único de installHash).
--        Limitado ao que o TTL de AnalyticsDailyUniqueInstall preservou.
INSERT IGNORE INTO `AnalyticsInstallFirstSeen`
  (`installHash`, `platform`, `appVersion`, `firstSeenDay`)
SELECT `installHash`, `platform`, `appVersion`, `day`
FROM `AnalyticsDailyUniqueInstall`
ORDER BY `day` ASC, `id` ASC;
