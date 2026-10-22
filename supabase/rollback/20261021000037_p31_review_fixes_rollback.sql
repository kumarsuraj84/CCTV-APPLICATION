-- Rollback of 20261021000037_p31_review_fixes.sql (P3-1 review round 1). Dry run: BEGIN; \i this file; ROLLBACK;
-- No BEGIN/COMMIT inside: run it as BEGIN; \i …; COMMIT; for real. Take the app back to before the round-1 code first (it calls
-- mfa_code_claim and mfa_enrolment_events). The used-code list is lost (harmless: it only remembers codes for three minutes).

DROP TRIGGER security_settings_audit_mfa ON public.security_settings;
DROP FUNCTION public.security_settings_audit_mfa();
DROP FUNCTION public.auth_events_guard_status();
DROP TRIGGER auth_events_no_truncate ON public.auth_events;
DROP TRIGGER auth_events_no_delete ON public.auth_events;
DROP FUNCTION public.auth_events_no_delete();
DROP FUNCTION public.mfa_enrolment_events(uuid);
DROP FUNCTION public.mfa_code_claim(uuid, text);
DROP TABLE public.mfa_used_codes;

NOTIFY pgrst, 'reload schema';
