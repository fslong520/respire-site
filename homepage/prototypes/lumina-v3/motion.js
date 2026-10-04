'use strict';
// Subtle, one-time entrance. Content remains visible without JS or observers.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
if (!reducedMotion.matches) {
  const hero = document.querySelector('.hero');
  for (const [index, item] of [...hero.querySelectorAll('.announcement,h1,.agent-line,.hero-description,.hero-definition,.hero-actions,.hero-principles')].entries()) {
    item.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }], {
      duration: 500, delay: index * 35, easing: 'cubic-bezier(.23,1,.32,1)', fill: 'backwards',
    });
  }
}
