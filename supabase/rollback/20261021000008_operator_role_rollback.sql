-- Undoes 20261021000008_operator_role.sql. Run after the rollbacks of 0011, 0010 and 0009.
BEGIN;
ALTER TYPE public.user_role RENAME VALUE 'operator' TO 'agent';
COMMIT;
