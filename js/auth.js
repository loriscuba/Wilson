// ── Google OAuth gate ─────────────────────────────────────────────────────────
// Sblocca la UI solo se l'utente autenticato è loriscuba@gmail.com.
// Dipende da `sb` (config.js) — deve essere caricato DOPO config.js.
//
// persistSession è false nel client Supabase (workaround per compatibilità con
// sb_publishable_ keys). La sessione viene salvata manualmente in localStorage
// e ripristinata tramite sb.auth.setSession() ad ogni caricamento.
(function () {
    const ALLOWED_EMAIL  = 'loriscuba@gmail.com';
    const SESSION_KEY    = 'wilson_session_v1';

    function unlock() { document.body.classList.remove('wilson-locked'); }
    function lock()   { document.body.classList.add('wilson-locked'); }

    function saveSession(session) {
        try {
            if (session?.access_token && session?.refresh_token) {
                localStorage.setItem(SESSION_KEY, JSON.stringify({
                    access_token:  session.access_token,
                    refresh_token: session.refresh_token,
                    expires_at:    session.expires_at,
                }));
            }
        } catch {}
    }

    function clearSession() {
        try { localStorage.removeItem(SESSION_KEY); } catch {}
    }

    async function tryRestoreSession() {
        if (!sb) return false;
        try {
            const raw = localStorage.getItem(SESSION_KEY);
            if (!raw) return false;
            const saved = JSON.parse(raw);
            // Non riprovare se il token è scaduto da più di 5 minuti (senza refresh_token valido)
            const { data, error } = await sb.auth.setSession({
                access_token:  saved.access_token,
                refresh_token: saved.refresh_token,
            });
            if (error || !data?.session) { clearSession(); return false; }
            if (data.session.user?.email === ALLOWED_EMAIL) {
                saveSession(data.session); // aggiorna con token rinfrescato
                unlock();
                return true;
            }
            clearSession();
            return false;
        } catch { return false; }
    }

    if (sb) {
        sb.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
                if (session?.user?.email === ALLOWED_EMAIL) {
                    saveSession(session);
                    unlock();
                } else {
                    sb.auth.signOut();
                    clearSession();
                    alert('Accesso negato. Usa loriscuba@gmail.com.');
                }
            } else if (event === 'SIGNED_OUT') {
                clearSession();
                lock();
            }
        });

        // Prima prova a ripristinare sessione salvata, poi controlla URL
        tryRestoreSession().then(restored => {
            if (!restored) {
                // Nessuna sessione salvata — controlla se siamo in un redirect OAuth
                sb.auth.getSession().then(({ data: { session } }) => {
                    if (session?.user?.email === ALLOWED_EMAIL) {
                        saveSession(session);
                        unlock();
                    }
                });
            }
        });
    }

    window.loginConGoogle = function () {
        if (!sb) return;
        sb.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.href.split('?')[0].split('#')[0] },
        });
    };

    window.logoutWilson = function () {
        if (!sb) return;
        clearSession();
        sb.auth.signOut();
    };
})();
