-- P2-5a (decision D-4, W-1; impact map M1): asset types for the location/asset model and the Wi-Fi inventory.
-- Enum values must be committed before any later migration can use them, so this file only adds values.
-- The type keeps its name device_type (the generated name Enums['device_type'] stays stable for the app; a rename to asset_type is
-- cosmetic and left to P2-5b/T-1). Enum values cannot be removed: the rollback of this file is a documented no-op.

ALTER TYPE public.device_type ADD VALUE IF NOT EXISTS 'sdwan_edge';
ALTER TYPE public.device_type ADD VALUE IF NOT EXISTS 'switch';
ALTER TYPE public.device_type ADD VALUE IF NOT EXISTS 'access_point';
ALTER TYPE public.device_type ADD VALUE IF NOT EXISTS 'router';
ALTER TYPE public.device_type ADD VALUE IF NOT EXISTS 'ups';
ALTER TYPE public.device_type ADD VALUE IF NOT EXISTS 'printer';
ALTER TYPE public.device_type ADD VALUE IF NOT EXISTS 'desktop';
ALTER TYPE public.device_type ADD VALUE IF NOT EXISTS 'laptop';
