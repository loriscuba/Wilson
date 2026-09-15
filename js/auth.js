// ── Google OAuth gate ─────────────────────────────────────────────────────────
// Sblocca la UI solo se l'utente autenticato è loriscuba@gmail.com.
// Dipende da `sb` (config.js) — deve essere caricato DOPO config.js.
(function () {
    const ALLOWED_EMAIL = 'loriscuba@gmail.com';

    function unlock() {
        document.body.classList.remove('wilson-locked');
    }

    function lock() {
        document.body.classList.add('wilson-locked');
    }

    async function checkSession() {
        if (!sb) return;
        const { data: { session } } = await sb.auth.getSession();
        if (session?.user?.email === ALLOWED_EMAIL) {
            unlock();
        }
    }

    // Ascolta cambi di stato auth (incluso il redirect OAuth)
    if (sb) {
        sb.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN') {
                if (session?.user?.email === ALLOWED_EMAIL) {
                    unlock();
                } else {
                    // Email non autorizzata: disconnetti subito
                    sb.auth.signOut();
                    alert('Accesso negato. Usa loriscuba@gmail.com.');
                }
            } else if (event === 'SIGNED_OUT') {
                lock();
            }
        });

        checkSession();
    }

    // Esposto globalmente per il bottone nel template HTML
    window.loginConGoogle = function () {
        if (!sb) return;
        sb.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.href.split('?')[0].split('#')[0] },
        });
    };

    window.logoutWilson = function () {
        if (!sb) return;
        sb.auth.signOut();
    };
})();
