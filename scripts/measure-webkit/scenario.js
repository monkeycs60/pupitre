// Scénario injecté dans la page : window.__params est posé avant ce fichier.
window.__probe = { step: 'start' };
(async () => {
  const params = window.__params;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (find, ms = 45_000) => {
    const started = performance.now();
    while (performance.now() - started < ms) {
      const found = find();
      if (found) return found;
      await sleep(100);
    }
    return null;
  };
  const step = (name) => { window.__probe = { ...window.__probe, step: name }; };
  try {
    step('project');
    const project = await until(() => [...document.querySelectorAll('button')]
      .find((button) => {
        const label = button.getAttribute('aria-label') ?? '';
        return label === params.project || label.startsWith(`${params.project},`) || button.textContent.trim() === params.project;
      }));
    if (!project) throw new Error(`projet introuvable : ${params.project}`);
    let conversation = null;
    const findConversation = () => [...document.querySelectorAll('.sidebar-section.conversations *')]
      .find((element) => element.childElementCount === 0 && element.textContent.startsWith(params.conversation));
    for (let attempt = 0; attempt < 4 && !conversation; attempt += 1) {
      project.click();
      conversation = await until(findConversation, 4_000);
      // La liste replie les conversations anciennes derrière « N autres » ; le filtre les montre toutes.
      const filter = conversation ? null : document.querySelector('.conversation-filter-input input');
      if (filter) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(filter, params.conversation);
        filter.dispatchEvent(new Event('input', { bubbles: true }));
        conversation = await until(findConversation, 8_000);
      }
    }
    if (!conversation) throw new Error(`conversation introuvable : ${params.conversation}`);
    step('conversation');
    conversation.click();
    await until(() => document.querySelector('.events-view .assistant-message'));
    await sleep(2_000);
    // Le fil remplace son conteneur pendant le chargement : une référence prise
    // plus tôt pointe vers un élément détaché, de hauteur nulle.
    let scroller = document.querySelector('.events-view');

    let rendered = { renderMs: null, nodes: null };
    let region = { top: 0, height: scroller.scrollHeight };
    if (params.scenario === 'changes') {
      step('changes');
      const button = await until(() => [...document.querySelectorAll('.code-workspace-card button')]
        .find((candidate) => candidate.textContent.includes('Voir les changements')));
      if (!button) throw new Error('pas de carte de commits dans cette conversation');
      const started = performance.now();
      button.click();
      const view = await until(() => document.querySelector('.changes-view .changes-summary') && document.querySelector('.changes-view'), 30_000);
      await frame(); await frame();
      rendered = { renderMs: Math.round(performance.now() - started), nodes: view.querySelectorAll('*').length };
      await sleep(params.settleMs);
      region = { top: scroller.scrollTop + view.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 100, height: view.getBoundingClientRect().height };
    }

    const scrollPass = async () => {
      scroller = document.querySelector('.events-view');
      const measured = () => (params.scenario === 'changes' ? document.querySelector('.changes-view').getBoundingClientRect().height : null);
      const heightBefore = measured();
      scroller.scrollTop = params.scenario === 'changes' ? region.top : 0;
      await frame();
      const end = params.scenario === 'changes' ? region.top + region.height : scroller.scrollHeight;
      const durations = [];
      let last = performance.now();
      while (scroller.scrollTop + scroller.clientHeight < end && durations.length < params.frames) {
        const before = scroller.scrollTop;
        scroller.scrollTop += params.stepPx;
        await frame();
        const now = performance.now();
        durations.push(now - last);
        last = now;
        if (scroller.scrollTop === before) break;
      }
      const sorted = [...durations].sort((a, b) => a - b);
      const percentile = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
      const heightAfter = measured();
      return {
        frames: durations.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        max: Math.round(sorted.at(-1) ?? 0),
        fps: durations.length ? Math.round(1000 * durations.length / durations.reduce((sum, value) => sum + value, 0)) : 0,
        heightShift: heightBefore === null ? 0 : Math.round(heightAfter - heightBefore),
      };
    };

    if (params.scenario === 'live') {
      // La fenêtre de mesure n'a jamais le focus : sans ce leurre, l'orbe et
      // les boucles CSS restent figées comme dans une app en arrière-plan.
      document.hasFocus = () => true;
      window.dispatchEvent(new Event('focus'));
      step('live');
      const line = await until(() => document.querySelector('.turn-work.is-live canvas'), 90_000);
      if (!line) throw new Error('aucun tour en cours dans cette conversation');
      await sleep(params.settleMs);
      const live = { ...(await scrollPass()), canvases: document.querySelectorAll('.turn-work.is-live canvas').length };
      if (live.canvases === 0) throw new Error('le tour s’est terminé pendant la mesure : relance un tour plus long');
      step('fin du tour');
      const ended = await until(() => !document.querySelector('.turn-work.is-live'), 240_000);
      if (!ended) throw new Error('le tour ne s’est pas terminé');
      await sleep(params.settleMs);
      window.__probe = { step: 'done', ...(await scrollPass()), live };
      return;
    }

    step('scroll');
    window.__probe = { step: 'done', ...rendered, ...(await scrollPass()) };
  } catch (error) {
    window.__probe = { step: 'error', message: String(error && error.message ? error.message : error) };
  }
})();
