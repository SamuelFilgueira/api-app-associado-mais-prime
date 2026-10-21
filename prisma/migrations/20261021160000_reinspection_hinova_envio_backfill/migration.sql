-- Backfill de Reinspection.hinovaEnvioStatus a partir do estado real das fotos
-- (ReinspectionPhoto.sentToHinova), que ja existia antes da migration
-- 20261021120000_reinspection_hinova_envio. Aquela migration deixou todas as
-- revistorias com o default NAO_ENVIADA, inclusive as que ja tinham todas as
-- fotos inseridas na Hinova.
--
-- Regras (idempotente, pode ser executado mais de uma vez):
--   todas as fotos com sentToHinova = 1              -> ENVIADA
--   parte das fotos com sentToHinova = 1             -> PARCIAL
--   nenhuma foto enviada (ou sem fotos)              -> mantem NAO_ENVIADA
-- Revistorias que ja receberam um envio registrado em ReinspectionHinovaEnvio
-- nao sao tocadas: o service ja consolidou o status delas.

UPDATE `Reinspection` r
JOIN (
    SELECT reinspectionId,
           COUNT(*)                                        AS total,
           SUM(CASE WHEN sentToHinova = 1 THEN 1 ELSE 0 END) AS enviadas
    FROM `ReinspectionPhoto`
    GROUP BY reinspectionId
) p ON p.reinspectionId = r.id
SET r.hinovaEnvioStatus = CASE
        WHEN p.total > 0 AND p.enviadas = p.total THEN 'ENVIADA'
        WHEN p.enviadas > 0                        THEN 'PARCIAL'
        ELSE 'NAO_ENVIADA'
    END
WHERE NOT EXISTS (
    SELECT 1 FROM `ReinspectionHinovaEnvio` e WHERE e.reinspectionId = r.id
);

-- Data de envio das fotos ja inseridas: nao existe registro historico, usa a
-- data de criacao da foto como melhor aproximacao, so onde ainda esta nulo.
UPDATE `ReinspectionPhoto`
SET hinovaEnviadaEm = createdAt
WHERE sentToHinova = 1 AND hinovaEnviadaEm IS NULL;
