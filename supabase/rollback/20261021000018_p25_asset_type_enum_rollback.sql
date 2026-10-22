-- Rollback of 20261021000018_p25_asset_type_enum.sql: intentionally a no-op.
-- PostgreSQL cannot remove values from an enum. The added values (sdwan_edge, switch, access_point, router, ups, printer, desktop,
-- laptop) are harmless once nothing uses them. The rollback of 20261021000019 (run before this one) refuses while any asset still has
-- one of them (review M10: that refusal now exists), because the old application does not know them. To remove the values for real:
-- recreate the type without them and cast the column.
SELECT 1;
