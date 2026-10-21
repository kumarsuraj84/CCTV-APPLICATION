BEGIN;

-- Ends every sign-in of one person: their sessions and, through the cascade, their refresh tokens.
-- Called by the server after a password reset or a deactivation, so old sessions cannot be used again,
-- not even after the person is reactivated.
CREATE FUNCTION public.revoke_user_sessions(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
  DELETE FROM auth.sessions WHERE user_id = p_user;
  -- Refresh tokens are removed with their session (ON DELETE CASCADE); this also removes any left over.
  DELETE FROM auth.refresh_tokens WHERE user_id = p_user::text;
END
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_user_sessions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_user_sessions(uuid) TO service_role;

COMMIT;
