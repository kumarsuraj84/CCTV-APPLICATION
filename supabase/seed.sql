-- Dev and test data only: the single organisation this app runs for.
INSERT INTO organizations (name, slug, is_owner)
VALUES ('CityKart', 'citykart', true)
ON CONFLICT (slug) DO NOTHING;
