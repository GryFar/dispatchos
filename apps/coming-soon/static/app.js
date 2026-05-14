// Day counter — days since project started (14 May 2026)
const PROJECT_START = new Date('2026-05-14T00:00:00-04:00');
const PROGRESS_TARGET = 25; // current ~25%

(function () {
  const now = new Date();
  const days = Math.max(0, Math.floor((now - PROJECT_START) / (1000 * 60 * 60 * 24)));
  const counter = document.getElementById('day-counter');
  if (counter) counter.textContent = days === 0 ? '1' : String(days);

  // Animate progress bar after page load
  setTimeout(() => {
    const fill = document.getElementById('progress-fill');
    if (fill) fill.style.width = PROGRESS_TARGET + '%';
  }, 400);
})();

// Email subscribe form
(function () {
  const form = document.getElementById('subscribe-form');
  const input = document.getElementById('email-input');
  const btn = document.getElementById('submit-btn');
  const msg = document.getElementById('form-msg');
  if (!form) return;

  // Honeypot anti-bot field added dynamically (invisible to humans)
  const hp = document.createElement('input');
  hp.type = 'text';
  hp.name = 'website';
  hp.tabIndex = -1;
  hp.autocomplete = 'off';
  hp.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0;';
  hp.setAttribute('aria-hidden', 'true');
  form.appendChild(hp);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    msg.className = 'form-msg';

    const email = input.value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      msg.textContent = 'Please enter a valid email address.';
      msg.classList.add('error');
      input.focus();
      return;
    }

    // Honeypot check
    if (hp.value) {
      // Silently "succeed" for bots
      btn.classList.add('is-done');
      input.disabled = true;
      return;
    }

    btn.classList.add('is-loading');
    btn.disabled = true;

    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          source: 'coming-soon',
          ts: Date.now(),
          referrer: document.referrer || null,
        }),
      });

      if (res.ok) {
        btn.classList.remove('is-loading');
        btn.classList.add('is-done');
        msg.textContent = "You're on the list. We'll email you at launch.";
        msg.classList.add('success');
        input.disabled = true;
      } else {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Subscribe failed');
      }
    } catch (err) {
      btn.classList.remove('is-loading');
      btn.disabled = false;
      msg.textContent = 'Could not save right now — try again in a sec, or email info@dispatchos.co.';
      msg.classList.add('error');
      console.error(err);
    }
  });

})();
