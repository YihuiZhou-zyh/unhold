// "Ask about this case" widget — feature-flagged: only runs with ?ask=1. All model output is escaped via h().
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('ask') === '0') return;

  const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SPARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2l2.2 6.3L20.5 10.5l-6.3 2.2L12 19l-2.2-6.3L3.5 10.5l6.3-2.2zM19 15l1 2.7 2.7 1-2.7 1-1 2.7-1-2.7-2.7-1 2.7-1z"/></svg>';
  const QUESTIONS = [
    'Why is my $68 on hold, and when will it be released?',
    'Will uploading tracking release my money faster?',
    'Is this order covered by Seller Protection?',
    "What happens if I don't respond to the dispute in time?",
    'How much is the dispute fee for my account?',
    'Can I ship with an untracked economy parcel?',
  ];

  const fab = document.createElement('button');
  fab.className = 'ua-fab';
  fab.type = 'button';
  fab.innerHTML = `${SPARK}<span>Ask Unhold</span>`;
  const panel = document.createElement('section');
  panel.className = 'ua-panel';
  panel.setAttribute('aria-label', 'Ask about this case');
  panel.innerHTML = `
    <div class="ua-head"><div class="ua-ico">${SPARK}</div><div><b>Ask about this case</b><small>answers cite PayPal policy</small></div><button class="ua-x" type="button" aria-label="Close">×</button></div>
    <div class="ua-body"><p class="ua-intro">Answers use only official PayPal policy excerpts and this case's live PayPal data. Not legal or financial advice.</p>
      <div class="ua-chips">${QUESTIONS.map((q) => `<button type="button" class="ua-chip">${h(q)}</button>`).join('')}</div><div class="ua-log"></div></div>
    <form class="ua-form"><input maxlength="500" placeholder="Ask about holds, disputes, fees…" aria-label="Your question" /><button class="ua-send" type="submit">Ask</button></form>
    <div class="ua-foot"><span class="ua-grounded">Grounded in PayPal sources · Qwen</span><span>PayPal decides at its discretion</span></div>`;
  document.body.append(fab, panel);

  const body = panel.querySelector('.ua-body');
  const log = panel.querySelector('.ua-log');
  const input = panel.querySelector('input');
  const send = panel.querySelector('.ua-send');
  const grounded = panel.querySelector('.ua-grounded');
  let busy = false;

  const open = () => { panel.classList.add('ua-open'); fab.classList.add('ua-hide'); setTimeout(() => input.focus(), 250); };
  const close = () => { panel.classList.remove('ua-open'); fab.classList.remove('ua-hide'); };
  fab.addEventListener('click', open);
  panel.querySelector('.ua-x').addEventListener('click', close);
  const add = (cls, html) => { const d = document.createElement('div'); d.className = `ua-msg ${cls}`; d.innerHTML = `<div class="ua-bub">${html}</div>`; log.append(d); body.scrollTop = body.scrollHeight; return d; };

  function render(r) {
    const byId = new Map(r.citations.map((c, i) => [c.id, i + 1]));
    // Escape first, then turn [P3] markers into numbered chips that link to the cited source.
    const text = h(r.answer_en).replace(/\[(P\d+)\]/g, (m, id) => {
      const c = r.citations.find((x) => x.id === id);
      return c ? `<a class="ua-ref" href="${h(c.url)}" target="_blank" rel="noopener" title="${h(c.title)}">${h(id)}</a>` : '';
    });
    const facts = r.case_facts_used.length ? `<div class="ua-facts">${r.case_facts_used.map((f) => `<span class="ua-fact">${h(f)}</span>`).join('')}</div>` : '';
    const cites = r.citations.length ? `<div class="ua-cites">${r.citations.map((c) => `
      <details class="ua-cite"><summary><span class="ua-ref">${h(c.id)}</span><a href="${h(c.url)}" target="_blank" rel="noopener">${h(c.title)}</a><span class="ua-q">quote ▾</span></summary>
        <blockquote>“${h(c.quote)}”<span class="ua-src">${h(c.source_name)} · ${h(c.year)}</span></blockquote></details>`).join('')}</div>` : '';
    const meta = `<div class="ua-meta"><span>${r.out_of_scope ? 'Outside the policies on file' : `${byId.size} source${byId.size === 1 ? '' : 's'} cited`}</span><span class="ua-conf-${h(r.confidence)}">confidence: ${h(r.confidence)}</span></div>`;
    add(`ua-bot${r.out_of_scope ? ' ua-oos' : ''}`, `<div>${text}</div>${facts}${cites}${meta}`);
    if (r.corpus_size) grounded.textContent = `Grounded in ${r.corpus_size} PayPal sources · Qwen`;
  }

  async function ask(q) {
    q = String(q || '').trim().slice(0, 500);
    if (!q || busy) return;
    busy = true; send.disabled = true; input.value = '';
    const mine = add('ua-me', h(q));
    const typing = add('ua-bot ua-typing', '<i></i><i></i><i></i>');
    try {
      const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) });
      const j = await res.json();
      typing.remove();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
      render(j);
      body.scrollTop = Math.max(0, mine.offsetTop - body.offsetTop - 10); // show the question and the start of its answer
    } catch (e) {
      typing.remove();
      add('ua-bot ua-err', `Sorry — I couldn't answer right now (${h(e.message)}).`);
    } finally { busy = false; send.disabled = false; }
  }

  panel.querySelectorAll('.ua-chip').forEach((b) => b.addEventListener('click', () => ask(b.textContent)));
  panel.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('ua-open')) close(); });

  // Demo/screenshot helper: &askopen=1 opens the panel and asks the first suggested question.
  if (params.get('askopen') === '1') { open(); ask(QUESTIONS[0]); }
})();
