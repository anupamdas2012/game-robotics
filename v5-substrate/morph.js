// Drives the features→robots crossfade. The .features-morph section is tall;
// its inner .fm-stage pins to the viewport. Scroll progress (0..1) through
// the outer section is written to a CSS variable and consumed by styles.css.

(function () {
  const section = document.querySelector('.features-morph');
  if (!section) return;

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) {
    section.classList.add('is-reduced');
    return;
  }

  const swap = section.querySelector('.fm-swap');
  const eyebrow = section.querySelector('.fm-eyebrow');
  let lastPhase = 'features';
  let ticking = false;

  function update() {
    const rect = section.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    let progress = -rect.top / total;
    progress = Math.max(0, Math.min(1, progress));

    section.style.setProperty('--progress', progress.toFixed(4));

    // Text swap at the crossfade midpoint.
    const phase = progress > 0.55 ? 'robots' : 'features';
    if (phase !== lastPhase) {
      if (phase === 'robots') {
        swap.textContent = 'in every robot you can imagine.';
        eyebrow.textContent = 'Endless combinations';
      } else {
        swap.textContent = 'in one place.';
        eyebrow.textContent = 'One creation environment';
      }
      lastPhase = phase;
    }

    ticking = false;
  }

  function onScroll() {
    if (!ticking) {
      window.requestAnimationFrame(update);
      ticking = true;
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          window.addEventListener('scroll', onScroll, { passive: true });
          window.addEventListener('resize', onScroll);
          update();
        } else {
          window.removeEventListener('scroll', onScroll);
          window.removeEventListener('resize', onScroll);
        }
      });
    },
    { rootMargin: '200px 0px' }
  );
  io.observe(section);

  update();
})();

// -----------------------------------------------------------------
// Prompt card: typewriter → blueprint reveal
// -----------------------------------------------------------------
(function () {
  const card = document.querySelector('.prompt-card[data-typewriter]');
  if (!card) return;

  const typedEl = card.querySelector('.prompt-typed');
  const statusText = card.querySelector('.status-text');
  const fullText = card.getAttribute('data-typewriter') || '';

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReduced) {
    typedEl.textContent = fullText;
    card.classList.add('is-typed', 'is-live', 'is-simulating', 'is-mech', 'is-editing', 'is-streaming');
    if (statusText) statusText.textContent = 'streaming telemetry';
    return;
  }

  let started = false;
  let hudStarted = false;
  const PHASES = ['is-typed', 'is-live', 'is-simulating', 'is-mech', 'is-editing', 'is-streaming'];

  async function type() {
    if (started) return;
    started = true;

    // Runs forever — one full workspace cycle per iteration.
    while (true) {
      // Reset UI to the "intent" starting state.
      typedEl.textContent = '';
      PHASES.forEach((c) => card.classList.remove(c));
      if (statusText) statusText.textContent = 'awaiting input…';
      await new Promise((r) => setTimeout(r, 900));

      if (statusText) statusText.textContent = 'compiling…';
      for (let i = 0; i < fullText.length; i++) {
        typedEl.textContent = fullText.slice(0, i + 1);
        // Slight jitter + longer pause on punctuation for natural feel
        const ch = fullText[i];
        let delay = 28 + Math.random() * 30;
        if (ch === ',' || ch === '.') delay += 180;
        await new Promise((r) => setTimeout(r, delay));
      }
      card.classList.add('is-typed');
      await new Promise((r) => setTimeout(r, 400));
      if (statusText) statusText.textContent = 'compiled → graph';
      card.classList.add('is-live');

      // After the blueprint is drawn (nodes ~800ms + wires ~1600ms), transition to sim.
      await new Promise((r) => setTimeout(r, 2600));
      if (statusText) statusText.textContent = 'running simulation';
      card.classList.add('is-simulating');
      if (!hudStarted) {
        startHudLoop(card);
        hudStarted = true;
      }

      // After the sim has looped a few times, reveal the mechanical design view.
      await new Promise((r) => setTimeout(r, 4500));
      if (statusText) statusText.textContent = 'inspecting mechanical';
      card.classList.add('is-mech');

      // After the CAD view sits for a beat, flip to the PCB review.
      await new Promise((r) => setTimeout(r, 4500));
      if (statusText) statusText.textContent = 'inspecting hardware';
      card.classList.add('is-editing');

      // After the PCB traces run, flip to live telemetry stream.
      await new Promise((r) => setTimeout(r, 5200));
      if (statusText) statusText.textContent = 'streaming telemetry';
      card.classList.add('is-streaming');

      // Sit on telemetry for a moment, then loop back to intent.
      await new Promise((r) => setTimeout(r, 6000));
    }
  }

  // Fake HUD telemetry: cycles state + speed + battery + ETA in a natural way
  function startHudLoop(card) {
    const stateEl = card.querySelector('[data-hud="state"]');
    const speedEl = card.querySelector('[data-hud="speed"]');
    const batEl = card.querySelector('[data-hud="battery"]');
    const etaEl = card.querySelector('[data-hud="eta"]');
    if (!stateEl || !speedEl || !batEl) return;

    // 6s loop matches the SVG animateMotion on the robot marker
    const LOOP = 6000;
    const states = [
      { at: 0,    text: 'leaving base', speed: 0.6 },
      { at: 900,  text: 'en route',     speed: 1.2 },
      { at: 2400, text: 'turning',      speed: 1.0 },
      { at: 3800, text: 'approaching',  speed: 0.8 },
      { at: 4800, text: 'delivering',   speed: 0.0 },
      { at: 5700, text: 'returning',    speed: 0.9 },
    ];
    let start = performance.now();
    let battery = 87;
    let batTick = start;

    function tick(now) {
      const t = (now - start) % LOOP;
      let cur = states[0];
      for (const s of states) if (t >= s.at) cur = s;
      stateEl.textContent = cur.text;
      speedEl.textContent = cur.speed.toFixed(1) + ' m/s';
      if (etaEl) {
        const remaining = Math.max(0, Math.round((LOOP - t) / 1000));
        etaEl.textContent = '00:' + String(remaining).padStart(2, '0');
      }
      if (now - batTick > 5000) {
        battery = Math.max(60, battery - 1);
        batEl.textContent = battery + '%';
        batTick = now;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // Only start typing once the entire card is on screen.
  // Card starts small (all panels collapsed) so this fires as expected;
  // if the card is ever taller than the viewport, we fall back to a
  // bottom-visible check driven off the same intersection callbacks.
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        const rect = e.boundingClientRect;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const fullyVisible = e.intersectionRatio >= 0.99;
        const bottomVisible = rect.bottom <= vh && rect.top >= 0;
        if (fullyVisible || bottomVisible) {
          type();
          io.disconnect();
        }
      });
    },
    { threshold: [0.5, 0.75, 0.9, 1] }
  );
  io.observe(card);
})();
