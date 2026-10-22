-- P2-5a inventory extensions (decisions D-4, D-5, W-1, W-2; brief item 1; impact map M3): per-location network definitions with
-- address validation, asset dependencies with cycle prevention, and the vendor capability matrix seeded from
-- docs/drishti/wifi-capability-research.md (documentation evidence only: nothing is lab-validated; anything not stated by a source
-- that was read stays 'unverified', and cells with no source at all are simply not seeded = unverified by default).
-- APPLY ONLY THROUGH `npx supabase migration up` (one transaction per file; no BEGIN/COMMIT here; review M1).

-- ═══ Network definitions (W-1, supplement §A) ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE public.network_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  management_cidr cidr NOT NULL,
  gateway inet,
  dns inet[] NOT NULL DEFAULT '{}',
  management_vlan integer CHECK (management_vlan IS NULL OR management_vlan BETWEEN 1 AND 4094),
  -- {"staff": 10, "guest": 20, "device": 30}: VLAN ids per purpose (only these keys, ids 1..4094).
  vlan_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovery_ranges cidr[] NOT NULL DEFAULT '{}',
  -- The SD-WAN routing / NAT context in words (the real SD-WAN addressing is an external unknown, docs/drishti/locations-model.md).
  sdwan_context text CHECK (sdwan_context IS NULL OR length(sdwan_context) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_definitions_location_key UNIQUE (location_id),
  CONSTRAINT network_definitions_location_fk FOREIGN KEY (location_id, org_id) REFERENCES public.locations (id, org_id),
  CONSTRAINT network_definitions_gateway_inside CHECK (gateway IS NULL OR gateway << management_cidr)
);
-- The vlan_map rule (known keys, VLAN ids 1..4094) is the trigger network_definitions_check below.
CREATE TRIGGER network_definitions_updated BEFORE UPDATE ON public.network_definitions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE FUNCTION public.network_definitions_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF jsonb_typeof(NEW.vlan_map) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'vlan_map must be an object' USING ERRCODE = '22023'; END IF;
  FOR k, v IN SELECT * FROM jsonb_each(NEW.vlan_map) LOOP
    IF k NOT IN ('staff', 'guest', 'device', 'other') THEN RAISE EXCEPTION 'unknown VLAN purpose %', k USING ERRCODE = '22023'; END IF;
    IF jsonb_typeof(v) <> 'number' OR (v #>> '{}')::numeric NOT BETWEEN 1 AND 4094 OR (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) THEN
      RAISE EXCEPTION 'VLAN ids are whole numbers from 1 to 4094' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER network_definitions_check BEFORE INSERT OR UPDATE ON public.network_definitions FOR EACH ROW EXECUTE FUNCTION public.network_definitions_check();

-- Is this address right for the asset's location? 'ok' inside the location's management network; 'outside_location_network'
-- otherwise; 'no_network_defined' when the location has none (another location's network — e.g. the head office's — is never
-- applied); 'not_an_address' for a host name; 'no_location' for an asset without a location.
CREATE FUNCTION public.network_validate_address(p_org uuid, p_asset uuid, p_host text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_loc uuid;
  v_cidr cidr;
  v_ip inet;
BEGIN
  SELECT a.location_id INTO v_loc FROM public.assets a WHERE a.id = p_asset AND a.org_id = p_org;
  IF v_loc IS NULL THEN RETURN 'no_location'; END IF;
  SELECT n.management_cidr INTO v_cidr FROM public.network_definitions n WHERE n.location_id = v_loc;
  IF v_cidr IS NULL THEN RETURN 'no_network_defined'; END IF;
  BEGIN
    v_ip := p_host::inet;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN 'not_an_address';
  END;
  RETURN CASE WHEN v_ip <<= v_cidr THEN 'ok' ELSE 'outside_location_network' END;
END
$$;

-- Everything to flag (never silently allowed): asset addresses outside their location's network, and locations whose management
-- networks overlap in the same address space.
CREATE FUNCTION public.network_address_conflicts(p_org uuid)
RETURNS TABLE (asset_id uuid, location_id uuid, host text, status text, other_location_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.asset_id, a.location_id, e.host, public.network_validate_address(p_org, e.asset_id, e.host), NULL::uuid
  FROM public.asset_endpoints e JOIN public.assets a ON a.id = e.asset_id AND a.archived_at IS NULL
  WHERE e.org_id = p_org AND e.retired_at IS NULL AND e.purpose = 'management'
    AND public.network_validate_address(p_org, e.asset_id, e.host) IN ('outside_location_network', 'not_an_address')
    AND EXISTS (SELECT 1 FROM public.network_definitions n WHERE n.location_id = a.location_id)
  UNION ALL
  SELECT NULL::uuid, n1.location_id, n1.management_cidr::text, 'overlapping_networks', n2.location_id
  FROM public.network_definitions n1 JOIN public.network_definitions n2
    ON n2.org_id = n1.org_id AND n2.location_id > n1.location_id AND n1.management_cidr && n2.management_cidr
  WHERE n1.org_id = p_org
    AND coalesce((SELECT s.id FROM public.address_spaces s WHERE s.location_id = n1.location_id AND s.kind = 'location_nat'), public.address_space_global(p_org))
      = coalesce((SELECT s.id FROM public.address_spaces s WHERE s.location_id = n2.location_id AND s.kind = 'location_nat'), public.address_space_global(p_org))
$$;

-- ═══ Asset dependencies (D-5): location → SD-WAN → switch → NVR / endpoint ════════════════════════════════════════════════
CREATE TABLE public.asset_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  child_asset_id uuid NOT NULL,
  parent_asset_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('network', 'power', 'recording')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_dependencies_not_self CHECK (child_asset_id <> parent_asset_id),
  CONSTRAINT asset_dependencies_key UNIQUE (child_asset_id, parent_asset_id, kind),
  CONSTRAINT asset_dependencies_child_fk FOREIGN KEY (child_asset_id, org_id) REFERENCES public.assets (id, org_id),
  CONSTRAINT asset_dependencies_parent_fk FOREIGN KEY (parent_asset_id, org_id) REFERENCES public.assets (id, org_id)
);
CREATE INDEX asset_dependencies_parent_idx ON public.asset_dependencies (parent_asset_id);

-- No cycles (of any kind): the new parent must not depend, directly or through others, on the child. Serialised per organisation.
CREATE FUNCTION public.asset_dependencies_no_cycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('asset_dependencies:' || NEW.org_id::text));
  IF EXISTS (
    WITH RECURSIVE up (id) AS (
      SELECT NEW.parent_asset_id
      UNION
      SELECT d.parent_asset_id FROM public.asset_dependencies d JOIN up ON d.child_asset_id = up.id WHERE d.id IS DISTINCT FROM NEW.id
    )
    SELECT 1 FROM up WHERE up.id = NEW.child_asset_id
  ) THEN
    RAISE EXCEPTION 'this dependency would make a cycle' USING ERRCODE = 'DR005';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER asset_dependencies_no_cycle BEFORE INSERT OR UPDATE ON public.asset_dependencies FOR EACH ROW EXECUTE FUNCTION public.asset_dependencies_no_cycle();

-- ═══ Vendor capability matrix (W-2) ══════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE public.device_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor text NOT NULL,
  model text NOT NULL,
  firmware_min text,
  firmware_max text,
  -- standalone = local web UI / on-box protocols; insight_local = Insight-managed device through its own limited UI;
  -- insight_app = NETGEAR Insight mobile app; insight_cloud = Insight Cloud Portal (research §1 legend).
  management_mode text NOT NULL CHECK (management_mode IN ('standalone', 'insight_local', 'insight_app', 'insight_cloud')),
  operation text NOT NULL CHECK (operation IN ('inventory', 'health_metrics', 'config_read', 'ssid_security', 'mac_acl', 'radio',
    'backup_restore', 'firmware_upgrade', 'reboot', 'snmpv1v2c', 'snmpv2c_compat', 'snmpv3', 'ssh', 'telnet', 'syslog', 'ntp', 'rest_api')),
  support text NOT NULL CHECK (support IN ('supported', 'unsupported', 'unverified')),
  source_ref text NOT NULL CHECK (source_ref ~ '^(S|I)[0-9]+'),
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  verified_at timestamptz,
  adapter_state text NOT NULL DEFAULT 'none' CHECK (adapter_state IN ('none', 'fake', 'experimental', 'lab_validated')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX device_capabilities_key ON public.device_capabilities (vendor, model, coalesce(firmware_min, ''), management_mode, operation);
COMMENT ON TABLE public.device_capabilities IS 'W-2: documentation evidence per vendor/model/firmware/mode/operation (docs/drishti/wifi-capability-research.md, read 2026-10-22). Nothing is lab-validated; rollout planning must refuse every configuration operation today.';

INSERT INTO public.device_capabilities (vendor, model, firmware_min, management_mode, operation, support, source_ref, notes) VALUES
  -- Group A: WAX615 (the model named by the owner). Standalone cells mostly unverified: the current manual (S3) was index-only.
  ('NETGEAR', 'WAX615', NULL, 'standalone', 'inventory', 'unverified', 'S3', 'Local dashboard exists; fields not read for WAX615.'),
  ('NETGEAR', 'WAX615', NULL, 'standalone', 'health_metrics', 'unverified', 'S3', 'Manual not read (over the fetch limit).'),
  ('NETGEAR', 'WAX615', NULL, 'standalone', 'ssid_security', 'unverified', 'S1', 'Data sheet lists 8 SSIDs and WPA3; local procedure not read.'),
  ('NETGEAR', 'WAX615', NULL, 'standalone', 'mac_acl', 'unverified', 'S4', 'MAC ACL exists (known issue in S4); local procedure not read.'),
  ('NETGEAR', 'WAX615', NULL, 'standalone', 'radio', 'unverified', 'S1', 'Capability on the data sheet only.'),
  ('NETGEAR', 'WAX615', NULL, 'standalone', 'backup_restore', 'unverified', 'S3', 'Manual not read.'),
  ('NETGEAR', 'WAX615', NULL, 'standalone', 'firmware_upgrade', 'unverified', 'S3', 'Manual not read.'),
  ('NETGEAR', 'WAX615', NULL, 'standalone', 'reboot', 'unverified', 'S3', 'Reset button held >= 10 s = factory reset (index-only).'),
  ('NETGEAR', 'WAX615', NULL, 'standalone', 'snmpv1v2c', 'unverified', 'S3', 'Manual has SNMPv1/v2c sections (index-only).'),
  ('NETGEAR', 'WAX615', '12.5.0.14', 'standalone', 'snmpv3', 'supported', 'S7', 'Added in 12.5.0.14; known issue: v2/v3 only through snmpwalk.'),
  ('NETGEAR', 'WAX615', '12.8.0.6', 'standalone', 'snmpv2c_compat', 'supported', 'S8', 'SNMPv2 backward compatibility from 12.8.0.6; snmpwalk-only issue persists.'),
  ('NETGEAR', 'WAX615', NULL, 'insight_app', 'inventory', 'supported', 'S1', 'App device page shows model, MAC, uptime, firmware.'),
  ('NETGEAR', 'WAX615', NULL, 'insight_app', 'health_metrics', 'supported', 'S1', 'Client name/MAC/IP/RSSI/channel/SSID, usage.'),
  ('NETGEAR', 'WAX615', NULL, 'insight_cloud', 'inventory', 'supported', 'S21', 'UI device list and health; machine-readable export unverified.'),
  ('NETGEAR', 'WAX615', NULL, 'insight_cloud', 'health_metrics', 'supported', 'S21', 'UI only.'),
  ('NETGEAR', 'WAX615', NULL, 'insight_cloud', 'config_read', 'supported', 'S22', 'UI only; no documented programmatic read.'),
  ('NETGEAR', 'WAX615', NULL, 'insight_cloud', 'ssid_security', 'supported', 'S22', 'UI; pushed on save; device groups.'),
  ('NETGEAR', 'WAX615', NULL, 'insight_cloud', 'mac_acl', 'unverified', 'S23', 'Custom ACL MAC/IP filters for "several WAX" models, list not given.'),
  ('NETGEAR', 'WAX615', NULL, 'insight_cloud', 'radio', 'supported', 'S22', 'Device groups include radio configuration.'),
  ('NETGEAR', 'WAX615', NULL, 'insight_cloud', 'backup_restore', 'unverified', 'I4', 'Leads conflict (I4 vs I8).'),
  ('NETGEAR', 'WAX615', NULL, 'insight_cloud', 'firmware_upgrade', 'supported', 'S22', 'Immediate, scheduled, batch, device group.'),
  ('NETGEAR', 'WAX615', NULL, 'insight_cloud', 'reboot', 'supported', 'S22', 'Single, multiple, scheduled.'),
  ('NETGEAR', 'WAX615', NULL, 'standalone', 'rest_api', 'unverified', 'S20', 'No on-device REST API documented anywhere found.'),
  -- Group B1: WAX610, standalone (manual 202-12098-01, July 2020, firmware 9.0.0.x).
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'inventory', 'supported', 'S9', 'UI: system name, MACs, serial, firmware, uptime.'),
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'health_metrics', 'supported', 'S9', 'UI: clients, RSSI, rates, channel utilisation.'),
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'config_read', 'supported', 'S9', 'UI only; backup is encrypted.'),
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'ssid_security', 'supported', 'S9', 'UI: 8 SSIDs, WPA2/WPA3, isolation, VLAN per SSID.'),
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'mac_acl', 'supported', 'S9', 'UI: 8 local MAC ACLs x 256, allow/deny, per SSID.'),
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'radio', 'supported', 'S9', 'UI; applying restarts the radio, clients reconnect.'),
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'backup_restore', 'supported', 'S9', 'Password-protected binary; restore reboots.'),
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'firmware_upgrade', 'supported', 'S9', 'Downgrade/revert clears the configuration.'),
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'reboot', 'supported', 'S9', 'UI and scheduled reboot.'),
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'snmpv1v2c', 'supported', 'S9', 'v1/v2 only; disabled by default; RW community "private" by default.'),
  ('NETGEAR', 'WAX610', '12.5.0.15', 'standalone', 'snmpv3', 'supported', 'S11', 'Added in 12.5.0.15; snmpwalk-only known issue.'),
  ('NETGEAR', 'WAX610', '12.8.0.7', 'standalone', 'snmpv2c_compat', 'supported', 'S12', 'SNMPv2 backward compatibility.'),
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'ssh', 'supported', 'S9', 'SSH toggle, enabled by default; no CLI reference.'),
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'syslog', 'supported', 'S9', 'Server IP, port 514, disabled by default.'),
  ('NETGEAR', 'WAX610', '9.0.0', 'standalone', 'ntp', 'supported', 'S9', 'Custom NTP host; client on by default.'),
  ('NETGEAR', 'WAX610', NULL, 'insight_local', 'ssid_security', 'unverified', 'S9', 'Insight-manageable settings are masked in the local UI.'),
  -- Group B2 / C: release-note evidence only.
  ('NETGEAR', 'WAX620', '12.8.0.7', 'standalone', 'snmpv2c_compat', 'supported', 'S13', 'SNMPv2 backward compatibility.'),
  ('NETGEAR', 'WAX630', '12.8.0.7', 'standalone', 'snmpv2c_compat', 'supported', 'S14', 'SNMPv2 backward compatibility.'),
  ('NETGEAR', 'WBE750', '12.5.0.22', 'standalone', 'snmpv3', 'supported', 'S15', 'Added in 12.5.0.22; snmpwalk-only known issue.'),
  ('NETGEAR', 'WBE750', '12.8.0.7', 'standalone', 'snmpv2c_compat', 'supported', 'S16', 'SNMPv2 backward compatibility.'),
  ('NETGEAR', 'WBE750', NULL, 'insight_cloud', 'firmware_upgrade', 'supported', 'S22', 'Insight generic.'),
  ('NETGEAR', 'WBE750', NULL, 'insight_cloud', 'radio', 'unverified', 'S23', 'Channel support added in Insight 7.6.6.'),
  ('NETGEAR', 'WBE750', NULL, 'insight_cloud', 'mac_acl', 'unverified', 'S23', 'Custom ACL filters for WBE700 series; list not given.'),
  -- Group D: WAX214 / WAX218, standalone (manual 202-12175-02, Jan 2022).
  ('NETGEAR', 'WAX214', NULL, 'standalone', 'inventory', 'supported', 'S18', 'UI device status page.'),
  ('NETGEAR', 'WAX214', NULL, 'standalone', 'health_metrics', 'supported', 'S18', 'UI; client list and kick/block.'),
  ('NETGEAR', 'WAX214', NULL, 'standalone', 'ssid_security', 'supported', 'S18', 'UI.'),
  ('NETGEAR', 'WAX214', NULL, 'standalone', 'mac_acl', 'supported', 'S18', 'Per SSID allow/deny list, off by default.'),
  ('NETGEAR', 'WAX214', NULL, 'standalone', 'radio', 'supported', 'S18', 'Channel, width, power (Auto RF default).'),
  ('NETGEAR', 'WAX214', NULL, 'standalone', 'backup_restore', 'supported', 'S18', 'Export .tar.gz / restore.'),
  ('NETGEAR', 'WAX214', NULL, 'standalone', 'firmware_upgrade', 'supported', 'S18', 'Local file upload only.'),
  ('NETGEAR', 'WAX214', NULL, 'standalone', 'reboot', 'supported', 'S18', 'UI and auto reboot schedule.'),
  ('NETGEAR', 'WAX214', NULL, 'standalone', 'snmpv1v2c', 'supported', 'S18', 'Off by default; RW community "private".'),
  ('NETGEAR', 'WAX214', NULL, 'standalone', 'snmpv3', 'supported', 'S18', 'One user; privacy DES only (weak).'),
  ('NETGEAR', 'WAX214', NULL, 'standalone', 'syslog', 'supported', 'S18', 'Remote syslog host.'),
  ('NETGEAR', 'WAX214', NULL, 'standalone', 'ntp', 'supported', 'S18', 'NTP server setting.'),
  -- Group E: WAC510, standalone (manual 202-11840-10, Sept 2022).
  ('NETGEAR', 'WAC510', NULL, 'standalone', 'mac_acl', 'supported', 'S19', '8 local ACLs, up to 512 MACs each.'),
  ('NETGEAR', 'WAC510', NULL, 'standalone', 'backup_restore', 'supported', 'S19', 'UI sections exist.'),
  ('NETGEAR', 'WAC510', NULL, 'standalone', 'firmware_upgrade', 'supported', 'S19', 'Incl. revert to backup firmware.'),
  ('NETGEAR', 'WAC510', NULL, 'standalone', 'snmpv1v2c', 'supported', 'S19', 'v1/v2 only; RW community "private".'),
  ('NETGEAR', 'WAC510', NULL, 'standalone', 'telnet', 'unsupported', 'S19', 'Removed: "no longer supported" (manual rev -06, Aug 2019).'),
  ('NETGEAR', 'WAC510', NULL, 'standalone', 'ssh', 'unverified', 'S19', 'Section removed from the manual (rev -08); not a statement of non-support.'),
  ('NETGEAR', 'WAC510', NULL, 'standalone', 'syslog', 'supported', 'S19', 'Section exists.');

-- ═══ Row security and privileges ═══════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.network_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_capabilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY network_definitions_select ON public.network_definitions FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND location_id IN (SELECT public.it_view_location_ids()));
CREATE POLICY asset_dependencies_select ON public.asset_dependencies FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND child_asset_id IN (SELECT public.it_view_asset_ids())
         AND parent_asset_id IN (SELECT public.it_view_asset_ids()));
REVOKE ALL ON public.network_definitions, public.asset_dependencies, public.device_capabilities FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.network_definitions, public.asset_dependencies TO service_role;
GRANT SELECT ON public.network_definitions, public.asset_dependencies TO authenticated;
-- The matrix is read by the server only in P2-5a (the Wi-Fi inventory screen of P2-5c reads it for wifi.inventory.view holders).
GRANT SELECT, INSERT, UPDATE ON public.device_capabilities TO service_role;

REVOKE ALL ON FUNCTION public.network_definitions_check(), public.network_validate_address(uuid, uuid, text),
  public.network_address_conflicts(uuid), public.asset_dependencies_no_cycle() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_validate_address(uuid, uuid, text), public.network_address_conflicts(uuid) TO service_role;

-- The purge (test/demo organisations) now also removes network definitions and dependencies (body of 20261021000019 + two lines).
CREATE OR REPLACE FUNCTION public.inventory_purge_test_org(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_secrets uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND (o.slug LIKE 'test-%' OR o.slug = 'demo-sample-data')) THEN
    RAISE EXCEPTION 'only test and demo organisations can be purged' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('drishti.purge_org', p_org::text, true);
  v_secrets := ARRAY(SELECT r.secret_id FROM public.recorders r WHERE r.org_id = p_org AND r.secret_id IS NOT NULL
                     UNION SELECT l.nvr_secret_id FROM public.locations l WHERE l.org_id = p_org AND l.nvr_secret_id IS NOT NULL);
  DELETE FROM public.outages WHERE org_id = p_org;
  DELETE FROM public.check_state WHERE org_id = p_org;
  DELETE FROM public.camera_channel_mappings WHERE org_id = p_org;
  DELETE FROM public.cameras WHERE org_id = p_org;
  DELETE FROM public.asset_dependencies WHERE org_id = p_org;
  DELETE FROM public.network_definitions WHERE org_id = p_org;
  DELETE FROM public.asset_endpoints WHERE org_id = p_org;
  UPDATE public.assets SET attached_recorder_id = NULL WHERE org_id = p_org AND attached_recorder_id IS NOT NULL;
  DELETE FROM public.recorders WHERE org_id = p_org;
  DELETE FROM public.assets WHERE org_id = p_org;
  DELETE FROM public.address_spaces WHERE org_id = p_org;
  UPDATE public.locations SET parent_location_id = NULL WHERE org_id = p_org AND parent_location_id IS NOT NULL;
  DELETE FROM public.locations WHERE org_id = p_org;
  DELETE FROM public.clusters WHERE org_id = p_org;
  DELETE FROM public.regions WHERE org_id = p_org;
  DELETE FROM vault.secrets WHERE id = ANY (v_secrets);
  PERFORM set_config('drishti.purge_org', '', true);
  RETURN jsonb_build_object('secrets_removed', cardinality(v_secrets));
END
$$;

NOTIFY pgrst, 'reload schema';
