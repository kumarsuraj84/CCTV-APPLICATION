-- Dev and test data only: the single organisation this app runs for.
INSERT INTO organizations (name, slug, is_owner)
VALUES ('CityKart', 'citykart', true)
ON CONFLICT (slug) DO NOTHING;

-- Release 1 (migration 20261021000044, P2-7 re-review R-5): the local dev/test stack honours the test fixtures' header
-- (x-drishti-test-fixture: on, tests/setup/fixtures.ts). A production database keeps this switch off (the migration's default).
-- P5.4 fix round 2 (migration 20261021000046): NEVER apply this file to a production database. There the update script has marked the
-- switch as a production one, and this statement fails ("this is a production database: the test fixture switch stays off"); the
-- production web app also refuses to start, and the Health page fails, while the switch is on.
UPDATE public.test_fixture_switch SET honoured = true;
