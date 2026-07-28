-- Converte `user.baseOrigin` de ENUM para VARCHAR.
--
-- Motivo: o enum `UserBaseOrigin` obrigava uma migration de schema a cada nova
-- empresa/base do grupo (MAIS_PRIME, MAIS_PRIME_RS, HERTZ, ...), gerando
-- divergência de schema entre os deploys. Com VARCHAR, as bases válidas passam
-- a ser definidas por ambiente (TENANT_BASES) e validadas na aplicação
-- (src/config/tenant.config.ts), mantendo um único schema para todos.
--
-- Compatibilidade: o MySQL converte os rótulos do ENUM para as mesmas strings
-- ('MAIS_PRIME', 'MAIS_PRIME_RS'), portanto não há perda nem transformação de
-- dados e o valor devolvido pela API permanece idêntico.

ALTER TABLE `user` MODIFY `baseOrigin` VARCHAR(50) NULL;
