/**
 * Small progressive-enhancement layer for the one-pager:
 *  - scroll reveal (.reveal → .is-visible)
 *  - in-view autoplay for <video data-inview>
 *  - animated stat counters ([data-count])
 *  - lightbox (<dialog id="lightbox">) for [data-lightbox] triggers
 *  - legal modals ([data-dialog-open="id"])
 * Everything degrades gracefully: without JS the content is fully visible.
 */
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Scroll reveal ----------
const revealEls = document.querySelectorAll<HTMLElement>('.reveal');
if (reducedMotion || !('IntersectionObserver' in window)) {
  revealEls.forEach((el) => el.classList.add('is-visible'));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-visible');
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.1 },
  );
  revealEls.forEach((el) => io.observe(el));
}

// ---------- Videos: play only while visible, never with reduced motion ----------
const videos = document.querySelectorAll<HTMLVideoElement>('video[data-inview]');
if (!reducedMotion) {
  const vio = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const v = e.target as HTMLVideoElement;
        if (e.isIntersecting) v.play().catch(() => {});
        else v.pause();
      }
    },
    { threshold: 0.25 },
  );
  // A missing clip (placeholder phase) simply keeps showing its poster.
  videos.forEach((v) => vio.observe(v));
}

// ---------- Stat counters ----------
const counters = document.querySelectorAll<HTMLElement>('[data-count]');
const runCounter = (el: HTMLElement) => {
  const target = Number(el.dataset.count);
  // Years (e.g. 1900) count from a nearby start so the animation stays short and fun.
  const start = target > 1000 ? target - 60 : 0;
  const duration = 1400;
  const t0 = performance.now();
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(start + (target - start) * eased));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
if (!reducedMotion) {
  const cio = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          runCounter(e.target as HTMLElement);
          cio.unobserve(e.target);
        }
      }
    },
    { threshold: 0.6 },
  );
  counters.forEach((c) => cio.observe(c));
}

// ---------- Lightbox ----------
const lightbox = document.querySelector<HTMLDialogElement>('#lightbox');
const stage = lightbox?.querySelector<HTMLElement>('[data-stage]');
document.querySelectorAll<HTMLElement>('[data-lightbox]').forEach((trigger) => {
  trigger.addEventListener('click', () => {
    if (!lightbox || !stage) return;
    const src = trigger.dataset.src!;
    const poster = trigger.dataset.poster;
    const alt = trigger.dataset.alt ?? '';
    stage.replaceChildren();
    if (trigger.dataset.lightbox === 'video') {
      const v = document.createElement('video');
      Object.assign(v, { src, controls: true, autoplay: true, playsInline: true, loop: true });
      if (poster) v.poster = poster;
      stage.append(v);
    } else {
      const img = document.createElement('img');
      img.src = src;
      img.alt = alt;
      stage.append(img);
    }
    lightbox.showModal();
  });
});

// ---------- Generic dialogs (lightbox close, legal notices) ----------
document.querySelectorAll<HTMLElement>('[data-dialog-open]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelector<HTMLDialogElement>(`#${btn.dataset.dialogOpen}`)?.showModal();
  });
});
document.querySelectorAll<HTMLDialogElement>('dialog').forEach((d) => {
  d.querySelectorAll('[data-dialog-close]').forEach((b) => b.addEventListener('click', () => d.close()));
  // Click on the backdrop closes the dialog.
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
  d.addEventListener('close', () => {
    d.querySelectorAll('video').forEach((v) => v.pause());
  });
});
