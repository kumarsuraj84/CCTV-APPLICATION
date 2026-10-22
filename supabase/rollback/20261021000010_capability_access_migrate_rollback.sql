-- Undoes 20261021000010_capability_access_migrate.sql: removes the grants the migration made and its report rows.
-- Grants are append-only for the API roles (no DELETE privilege); this administrative clean-up runs as the table owner.
-- Grants made by people after the migration (source 'manual') are kept; the 0009 rollback drops the table altogether.
-- Order: 0011, 0010, 0009, 0008 rollbacks.
BEGIN;
DELETE FROM public.access_grants WHERE source LIKE 'migrated:%';
DELETE FROM public.access_migration_report;
COMMIT;
