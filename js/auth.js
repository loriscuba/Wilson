// ── Login gate a PIN ─────────────────────────────────────────────────────────
// Blocco lato client per evitare accessi occasionali/non autorizzati.
// Non sostituisce una vera autenticazione: chi ha accesso al sorgente può
// aggirarlo. Serve solo a impedire che link condivisi vengano aperti da chiunque.
(function () {
    const PIN_HASH = '6fa0b9010de4170dbe2153884069668def7b78919fab3284c90d7b591b1f54a5';
    const STORAGE_KEY = 'wilson_auth_token';

    const body = document.body;
    const overlay = document.getElementById('wilson-login-overlay');
    const digitsWrap = document.getElementById('wl-digits');
    const inputs = Array.from(digitsWrap.querySelectorAll('input'));
    const errorEl = document.getElementById('wl-error');
    const submitBtn = document.getElementById('wl-submit');

    async function sha256Hex(text) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function unlock() {
        body.classList.remove('wilson-locked');
    }

    // Se il device è già autenticato, sblocca subito (prima ancora che il
    // resto della pagina venga renderizzato) per evitare flash del contenuto.
    if (localStorage.getItem(STORAGE_KEY) === PIN_HASH) {
        unlock();
    } else {
        inputs[0]?.focus();
    }

    function showError(msg) {
        errorEl.textContent = msg;
        digitsWrap.classList.remove('wl-shake');
        void digitsWrap.offsetWidth; // restart animazione
        digitsWrap.classList.add('wl-shake');
    }

    function currentPin() {
        return inputs.map(i => i.value).join('');
    }

    function resetInputs() {
        inputs.forEach(i => (i.value = ''));
        inputs[0]?.focus();
    }

    async function trySubmit() {
        const pin = currentPin();
        if (pin.length !== 4) {
            showError('Inserisci 4 cifre');
            return;
        }
        const hash = await sha256Hex(pin);
        if (hash === PIN_HASH) {
            localStorage.setItem(STORAGE_KEY, hash);
            errorEl.textContent = '';
            unlock();
        } else {
            showError('PIN errato');
            resetInputs();
        }
    }

    inputs.forEach((input, idx) => {
        input.addEventListener('input', () => {
            input.value = input.value.replace(/\D/g, '').slice(-1);
            if (input.value && idx < inputs.length - 1) {
                inputs[idx + 1].focus();
            } else if (input.value && idx === inputs.length - 1) {
                trySubmit();
            }
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Backspace' && !input.value && idx > 0) {
                inputs[idx - 1].focus();
            } else if (e.key === 'Enter') {
                trySubmit();
            }
        });
        input.addEventListener('paste', e => {
            const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
            if (!text) return;
            e.preventDefault();
            text.slice(0, 4).split('').forEach((d, i) => {
                if (inputs[i]) inputs[i].value = d;
            });
            const next = inputs[Math.min(text.length, inputs.length - 1)];
            next?.focus();
            if (text.length >= 4) trySubmit();
        });
    });

    submitBtn.addEventListener('click', trySubmit);
})();
