-- P2-1 (decision D-16, directive AC-15): the human role "agent" is called "operator" from now on. The name "agent" is kept free for the
-- endpoint agents of a later phase. Renaming the enum value keeps every row; nothing is copied.
-- Rollback: supabase/rollback/20261021000008_operator_role_rollback.sql
BEGIN;

ALTER TYPE public.user_role RENAME VALUE 'agent' TO 'operator';

COMMIT;
