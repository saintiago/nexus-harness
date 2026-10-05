import { createJourney } from './journey.js';

/** The story both prototype roles open, interact with and screenshot during the host check. */
export default {
  title: 'Fixture/Release journey',
};

function renderJourney() {
  const journey = createJourney();
  const panel = document.createElement('section');
  panel.className = 'release-journey';
  panel.style.fontFamily = 'sans-serif';
  panel.style.maxWidth = '24rem';
  panel.style.padding = '1rem';
  panel.style.border = '1px solid #888';
  panel.style.borderRadius = '0.5rem';
  panel.innerHTML = [
    '<h1 style="margin:0 0 0.5rem;font-size:1.25rem">Release journey</h1>',
    '<p style="margin:0 0 0.75rem">Status: <strong data-status>idle</strong></p>',
    '<button type="button" data-action="advance">Advance the release</button>',
  ].join('');
  panel.querySelector('[data-action="advance"]').addEventListener('click', () => {
    panel.querySelector('[data-status]').textContent = journey.next();
  });
  return panel;
}

export const StateChangingJourney = {
  render: renderJourney,
};
