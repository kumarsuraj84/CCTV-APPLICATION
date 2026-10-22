-- Rollback of 20261021000018_p25_asset_type_enum.sql: intentionally a no-op.
-- PostgreSQL cannot remove values from an enum. The added values (sdwan_edge, switch, access_point, router, ups, printer, desktop,
-- laptop) are harmless once nothing uses them; the rollback of 20261021000019 refuses to run while any asset still has one of them
-- (it would otherwise leave rows the old application does not know). To remove them for real: recreate the type and cast the column.
SELECT 1;
