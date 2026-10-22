BEGIN;
CREATE TABLE public.camera_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT camera_groups_org_name_key UNIQUE (org_id, name),
  CONSTRAINT camera_groups_id_org_key UNIQUE (id, org_id)
);
CREATE TABLE public.camera_group_items (
  org_id uuid NOT NULL,
  group_id uuid NOT NULL,
  camera_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, camera_id),
  FOREIGN KEY (group_id, org_id) REFERENCES public.camera_groups (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (camera_id, org_id) REFERENCES public.cameras (id, org_id) ON DELETE CASCADE
);
CREATE INDEX camera_group_items_camera_idx ON public.camera_group_items (camera_id);
CREATE TRIGGER camera_groups_updated BEFORE UPDATE ON public.camera_groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.camera_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.camera_group_items ENABLE ROW LEVEL SECURITY;

-- A group is visible to people who see everything, to its creator, and to anyone who may see at least one camera in it.
CREATE POLICY camera_groups_select ON public.camera_groups FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id()) AND (
      (SELECT public.is_staff_all()) OR created_by = auth.uid() OR
      id IN (SELECT group_id FROM public.camera_group_items WHERE camera_id IN (SELECT public.visible_camera_ids()))
    )
  );
-- Items: only the cameras the reader may see.
CREATE POLICY camera_group_items_select ON public.camera_group_items FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND camera_id IN (SELECT public.visible_camera_ids()));

REVOKE ALL ON public.camera_groups, public.camera_group_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.camera_groups, public.camera_group_items TO authenticated;
GRANT ALL ON public.camera_groups, public.camera_group_items TO service_role;
COMMIT;
