(function () {
  const FN_WORDS = new Set(['a','an','the','to','of','in','on','at','by','for','and']);

  function boot() {
    if (!window.APP || !Array.isArray(window.APP.tokens)) {
      return setTimeout(boot, 0);
    }

    // ---------- One-time UI style injector ----------
    (function ensureUIStyles(){
      if (document.getElementById('uiEnhanceStyle')) return;
      const s = document.createElement('style');
      s.id = 'uiEnhanceStyle';
      s.textContent = `
        :root{
          --card:#0b1320; --text:#e2e8f0; --muted:#94a3b8; --border:#253142;
          --brand:#3b82f6; --brand-2:#60a5fa; --shadow:0 6px 18px rgba(2,6,23,.25);
        }
        #studentPanel{
          background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
          border:1px solid var(--border); border-radius:12px; padding:.5rem .6rem;
          box-shadow: var(--shadow); animation: fadeSlideIn .35s ease-out both;
        }
        #studentPanel .panel-title{
          display:inline-flex; align-items:center; gap:.4rem; color:var(--muted); font-weight:600;
          margin-right:.35rem; padding:.2rem .45rem; border:1px solid rgba(148,163,184,.18);
          border-radius:.45rem; background:rgba(255,255,255,.03)
        }
        .icon-input{ position:relative; display:inline-flex; align-items:center }
        .icon-input svg{ position:absolute; left:.5rem; width:16px; height:16px; color:var(--muted); opacity:.9 }
        .icon-input input{ padding-left:1.8rem !important }

        .dark-select{
          appearance:none; -webkit-appearance:none; -moz-appearance:none;
          background: var(--card); color: var(--text); border: 1px solid var(--border);
          border-radius: .6rem; padding: .45rem 2rem .45rem .6rem; line-height: 1.2;
          box-shadow: var(--shadow);
          background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 20 20'%3E%3Cpath fill='%2394a3b8' d='M5.5 7.5 10 12l4.5-4.5'/%3E%3C/svg%3E");
          background-repeat:no-repeat; background-position:right .6rem center; background-size:14px 14px;
          transition: border-color .2s ease, box-shadow .2s ease, transform .06s ease;
        }
        .dark-select:hover{ border-color: rgba(148,163,184,.55) }
        .dark-select:focus{ outline:none; border-color: rgba(59,130,246,.65); box-shadow: 0 0 0 2px rgba(59,130,246,.35) }
        .dark-select:active{ transform: translateY(0.5px) }
        .dark-select option{ color:#e2e8f0; background:#0b1220 }

        .btn-brand{
          display:inline-flex; align-items:center; gap:.45rem;
          background: linear-gradient(180deg, var(--brand), var(--brand-2));
          color:white; border:1px solid rgba(255,255,255,.15);
          padding:.5rem .8rem; border-radius:.6rem; font-weight:600;
          box-shadow: 0 10px 30px rgba(59,130,246,.25);
          transition: transform .06s ease, box-shadow .2s ease, filter .2s ease;
        }
        .btn-brand:hover{ filter:brightness(1.04); box-shadow: 0 12px 34px rgba(59,130,246,.32) }
        .btn-brand:active{ transform: translateY(1px) }
        .btn-brand svg{ width:16px; height:16px }

        #recIndicator.active{ animation: recPulse 1.1s ease-in-out infinite }
        @keyframes recPulse{ 0%,100% { box-shadow:0 0 0 0 rgba(239,68,68,.45) } 50%{ box-shadow:0 0 0 8px rgba(239,68,68,.05) } }

        .caret{ display:inline-block; width:10px; height:1.2em; border-left:2px solid var(--muted);
                animation: blink .95s steps(2, start) infinite; vertical-align:middle; transform: translateY(2px) }
        @keyframes blink{ 50% { opacity: 0 } }

        .metric-pulse{ animation: metricPop .28s ease-out }
        @keyframes metricPop{ 0%{transform:scale(1)} 40%{transform:scale(1.06); text-shadow:0 0 14px rgba(96,165,250,.3)} 100%{transform:scale(1)} }

        @keyframes fadeSlideIn{ from{opacity:0; transform: translateY(6px)} to{opacity:1; transform: translateY(0)} }

        [data-tip]{ position:relative }
        [data-tip]:hover::after{
          content:attr(data-tip); position:absolute; bottom:calc(100% + 6px); left:0;
          background:#0b1220; color:#e2e8f0; border:1px solid #253142; white-space:nowrap;
          padding:.25rem .45rem; border-radius:.4rem; font-size:.75rem; opacity:.95; pointer-events:none; box-shadow: var(--shadow);
        }
      `;
      document.head.appendChild(s);
    })();
    // ---------------------------------------------------

    // (single set of references — removed duplicates)
    const tokens  = window.APP.tokens;
    const passage = document.getElementById('passage');
    const wordsEls = [...document.querySelectorAll('.word')];

    const dot = document.getElementById('recIndicator');
    const statusText = document.getElementById('statusText');
    const insertionLine = document.getElementById('insertionLine');

    const btnStart = document.getElementById('btnStart');
    const btnPause = document.getElementById('btnPause');
    const btnStop  = document.getElementById('btnStop');
    const btnWrong = document.getElementById('btnWrong');

    const summary = document.getElementById('summary');
    const wcpmEl  = document.getElementById('wcpm');
    const accEl   = document.getElementById('accuracy');
    const errEl   = document.getElementById('errors');

    const errorsCard  = document.getElementById('errorsCard');
    const errorPanel  = document.getElementById('errorPanel');
    const mispronList = document.getElementById('mispronList');
    const omissionList= document.getElementById('omissionList');
    const subList     = document.getElementById('subList');
    const insList     = document.getElementById('insList');
    const repList     = document.getElementById('repList');
    const transList   = document.getElementById('transList');
    const revList     = document.getElementById('revList');

    const sensSlider = document.getElementById('sensitivity');
    const sensLabel  = document.getElementById('sensLabel');

    const forceServer = document.getElementById('forceServer');
    const asrBanner   = document.getElementById('asrBanner');

    // ======== Name sanitization (multi-word + punctuation) ========
    function sanitizeName(value, { max=64, uppercase=false } = {}){
      let v = String(value || '')
        .replace(/[^\p{L}\p{M}\s'’\.\-,]/gu, '')   // keep letters/marks, space, ' ’ . , -
        .replace(/\s+/g, ' ')
        .replace(/([.'’,-]){2,}/g, '$1')
        .replace(/\s+([.'’,-])/g, '$1')
        .replace(/([.'’,-])\s+/g, '$1 ')
        .trim();
      if (uppercase) v = v.toUpperCase();
      if (v.length > max) v = v.slice(0, max);
      return v;
    }
    // ===============================================================

    // ======== Student panel ========
    const legacyName = document.getElementById('studentName');
    if (legacyName) legacyName.style.display = 'none';

    const panel = document.createElement('div');
    panel.id = 'studentPanel';
    panel.style.display = 'inline-flex';
    panel.style.flexWrap = 'wrap';
    panel.style.gap = '8px';
    panel.style.alignItems = 'center';
    panel.style.marginLeft = '10px';

    // Icon factory
    function icon(pathD){
      const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('width','16'); svg.setAttribute('height','16'); svg.setAttribute('aria-hidden','true');
      const p = document.createElementNS('http://www.w3.org/2000/svg','path');
      p.setAttribute('fill','currentColor'); p.setAttribute('d', pathD);
      svg.appendChild(p); return svg;
    }
    const icUser  = "M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-4.4 0-8 2.6-8 6v2h16v-2c0-3.4-3.6-6-8-6z";
    const icBadge = "M12 1l3 3h4v4l3 3-3 3v4h-4l-3 3-3-3H5v-4l-3-3 3-3V4h4l3-3z";
    const icID    = "M3 5h18v14H3V5zm4 3h6v2H7V8zm0 4h10v2H7v-2z";

    function iconWrap(input, path, tip){
      const wrap = document.createElement('div');
      wrap.className = 'icon-input';
      if (tip) wrap.setAttribute('data-tip', tip);
      wrap.style.display = 'inline-flex';
      wrap.style.alignItems = 'center';
      wrap.style.position = 'relative';
      wrap.appendChild(icon(path));
      wrap.appendChild(input);
      return wrap;
    }

    function makeInput(id, ph, width, maxLen) {
      const inp = document.createElement('input');
      inp.id = id;
      inp.placeholder = ph;
      inp.required = true;
      inp.autocomplete = 'off';
      if (maxLen) inp.maxLength = maxLen;
      inp.className = 'input';
      inp.style.padding = '.45rem .55rem';
      inp.style.borderRadius = '.6rem';
      inp.style.border = '1px solid var(--border)';
      inp.style.background = 'rgba(255,255,255,.03)';
      inp.style.color = 'inherit';
      inp.style.width = width;
      inp.style.transition = 'box-shadow .2s ease, border-color .2s ease';
      inp.addEventListener('focus', ()=>{ inp.style.boxShadow='0 0 0 2px rgba(59,130,246,.35)'; inp.style.borderColor='rgba(59,130,246,.65)';});
      inp.addEventListener('blur',  ()=>{ inp.style.boxShadow='none'; inp.style.borderColor='var(--border)';});
      return inp;
    }

    const titleChip = document.createElement('span');
    titleChip.className = 'panel-title';
    titleChip.appendChild(icon(icUser));
    titleChip.appendChild(document.createTextNode('Student'));

    const surnameInput = makeInput('surname', 'Surname (e.g., Dela Cruz, O’Connor, Smith-Jones)', '220px', 64);
    const firstInput   = makeInput('firstName', 'First name(s) (e.g., Anne Marie)', '200px', 64);
    const miInput      = makeInput('middleInitial', 'Middle initial(s) (e.g., A., A B, A-B)', '180px', 24);

    surnameInput.addEventListener('input', () => { surnameInput.value = sanitizeName(surnameInput.value, {max:64}); });
    firstInput  .addEventListener('input', () => { firstInput.value   = sanitizeName(firstInput.value,   {max:64}); });
    miInput     .addEventListener('input', () => { miInput.value      = sanitizeName(miInput.value,      {max:24, uppercase:true}); });

    // --- Grade Level DROPDOWN (Grade 7–10, dark theme) ---
    const gradeSel = document.createElement('select');
    gradeSel.id = 'sessGradeLevel';
    gradeSel.required = true;
    gradeSel.className = 'input dark-select';
    gradeSel.style.width = '170px';
    gradeSel.setAttribute('data-tip','Select Grade Level');

    function addOpt(val, label, disabled=false, selected=false){
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      if (disabled) o.disabled = true;
      if (selected) o.selected = true;
      return o;
    }
    gradeSel.appendChild(addOpt('', 'Grade Level', true, true));
    gradeSel.appendChild(addOpt('7', 'Grade 7'));
    gradeSel.appendChild(addOpt('8', 'Grade 8'));
    gradeSel.appendChild(addOpt('9', 'Grade 9'));
    gradeSel.appendChild(addOpt('10','Grade 10'));

    // Save button
    let saveBtn = document.getElementById('saveSession');
    if (!saveBtn) { saveBtn = document.createElement('button'); saveBtn.id = 'saveSession'; saveBtn.type = 'button'; }
    saveBtn.classList.add('btn-brand');
    saveBtn.innerHTML = '';
    saveBtn.appendChild(icon(icBadge));
    saveBtn.appendChild(document.createTextNode('Save Session'));

    // Assemble panel
    panel.appendChild(titleChip);
    panel.appendChild(iconWrap(surnameInput, icID, 'Surname (multi-word & punctuation allowed)'));
    panel.appendChild(iconWrap(firstInput,  icUser, 'First name(s)'));
    panel.appendChild(iconWrap(miInput,     icBadge,'Middle initial(s)'));
    const gradeWrap = document.createElement('div');
    gradeWrap.style.display='inline-flex'; gradeWrap.style.alignItems='center'; gradeWrap.style.gap='.4rem';
    const gradeLabel = document.createElement('span'); gradeLabel.className='muted'; gradeLabel.style.fontWeight='600'; gradeLabel.textContent='Grade';
    gradeWrap.appendChild(gradeLabel); gradeWrap.appendChild(gradeSel);
    panel.appendChild(gradeWrap);
    panel.appendChild(saveBtn);

    const btnWrongParent = btnWrong && btnWrong.parentElement;
    if (btnWrongParent) btnWrong.insertAdjacentElement('afterend', panel);

    // Validation
    function requireField(el){
      const v = sanitizeName(el.value);
      if (!v) {
        el.style.outline = '2px solid rgba(220,38,38,.7)'; el.style.outlineOffset = '2px';
        el.animate([{transform:'translateX(0)'},{transform:'translateX(-2px)'},{transform:'translateX(2px)'},{transform:'translateX(0)'}], {duration:160});
        return false;
      }
      el.style.outline = 'none'; return true;
    }
    function requireGrade(){
      if (!gradeSel.value) {
        gradeSel.style.outline = '2px solid rgba(220,38,38,.7)'; gradeSel.style.outlineOffset = '2px';
        gradeSel.animate([{transform:'translateY(0)'},{transform:'translateY(-2px)'},{transform:'translateY(0)'}], {duration:160});
        return false;
      }
      gradeSel.style.outline = 'none'; return true;
    }
    // ==========================================================

    let currentIndex = 0, startedAt = 0, pausedAccum = 0, pauseStart = 0, recording = false;
    let mediaRecorder, chunks = [];
    let lastStatus = [], lastEvents = [];
    let origWSR = null, wrongSpeaking = false;

    // ---------- LIVE TIMER ----------
    let liveTimerEl = document.getElementById('liveTimer');
    if (!liveTimerEl) {
      liveTimerEl = document.createElement('span');
      liveTimerEl.id = 'liveTimer';
      liveTimerEl.className = 'muted';
      liveTimerEl.style.marginLeft = '8px';
      statusText?.insertAdjacentElement('afterend', liveTimerEl);
    }
    let finalDurationSec = null;
    let liveTimerRAF = null;

    function fmtSec(s) { return (Math.max(0, s)).toFixed(1); }
    function cancelTimerLoop(){ if (liveTimerRAF) cancelAnimationFrame(liveTimerRAF); liveTimerRAF = null; }
    function startTimerLoop(){
      cancelTimerLoop();
      const tick = () => {
        let sec = 0;
        if (finalDurationSec != null) sec = finalDurationSec;
        else if (recording) {
          if (btnPause.disabled && pauseStart) sec = (pauseStart - startedAt - pausedAccum) / 1000;
          else sec = (performance.now() - startedAt - pausedAccum) / 1000;
        } else if (startedAt) sec = (performance.now() - startedAt - pausedAccum) / 1000;
        liveTimerEl.textContent = ` • ${fmtSec(sec)}s`;
        liveTimerRAF = requestAnimationFrame(tick);
      };
      liveTimerRAF = requestAnimationFrame(tick);
    }
    // --------------------------------

    // ---------- TYPEWRITER ----------
    let twShown = '', twTarget = '', twRAF = null, lastTailStr = '';
    function esc(s) { return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
    function lcp(a,b){ let i=0, n=Math.min(a.length,b.length); while(i<n && a[i]===b[i]) i++; return a.slice(0,i); }
    function setCaretHTML(text){ insertionLine.innerHTML = esc(text) + ' <span class="caret"></span>'; }
    function ensureTWLoop(){
      if (twRAF) return;
      const tick = () => {
        if (twShown.length > twTarget.length || twTarget.slice(0, twShown.length) !== twShown) twShown = lcp(twShown, twTarget);
        if (twShown === twTarget) { twRAF = null; return; }
        const step = Math.min(3, twTarget.length - twShown.length);
        twShown += twTarget.slice(twShown.length, twShown.length + step);
        setCaretHTML(twShown);
        twRAF = requestAnimationFrame(tick);
      };
      twRAF = requestAnimationFrame(tick);
    }
    function buildSpokenTail(allTokens) {
      const words = []; const maxTail = 24;
      for (let i=0; i<allTokens.length; i++){
        const t = allTokens[i]; if (!t || !t.text) continue;
        const clean = String(t.text).replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g,''); if (!clean) continue;
        if (words.length && words[words.length-1].toLowerCase() === clean.toLowerCase()) continue;
        if (t.final || i > allTokens.length - 5) words.push(clean);
      }
      return words.slice(Math.max(0, words.length - maxTail)).join(' ');
    }
    function updateTypewriter(allTokens){
      const target = buildSpokenTail(allTokens);
      if (target === lastTailStr) return;
      lastTailStr = target; twTarget = target; ensureTWLoop();
    }
    function resetTypewriter(){ twShown = ''; twTarget = ''; lastTailStr = ''; setCaretHTML(''); }
    // ---------------------------------------------------

    recorder.init('vu');
    asr.init({ lang: passage.dataset.lang || 'en-US' });

    function outlineCurrent() {
      wordsEls.forEach(el => el.classList.remove('current'));
      if (wordsEls[currentIndex]) wordsEls[currentIndex].classList.add('current');
    }
    outlineCurrent();

    function scrollCurrentIntoView(){
      const el = wordsEls[currentIndex], container = passage; if (!el || !container) return;
      const r = el.getBoundingClientRect(), c = container.getBoundingClientRect(), pad = 32;
      const outH = r.left < c.left + pad || r.right > c.right - pad;
      const outV = r.top < c.top || r.bottom > c.bottom;
      if (outH || outV){ el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }); }
    }

    function setStatus(msg) { statusText.textContent = msg; }

    function mapSensitivity(val) {
      const t = Math.max(0, Math.min(100, Number(val) || 40)) / 100;
      const minConfidence = 0.6 + 0.3 * t;
      const maxEd = t < 0.33 ? 2 : (t < 0.75) ? 1 : 0;
      const label = t < 0.33 ? 'Lenient' : (t < 0.75) ? 'Balanced' : 'Strict';
      return { minConfidence, maxEd, label };
    }
    function updateSensLabel() {
      const { label, minConfidence, maxEd } = mapSensitivity(sensSlider.value);
      sensLabel.textContent = `${label} (conf≥${minConfidence.toFixed(2)}, fuzz≤${maxEd})`;
    }
    updateSensLabel();
    sensSlider?.addEventListener('input', updateSensLabel);

    // Metric pulse helper
    function setMetric(el, value, digits){
      const newTxt = value.toFixed(digits);
      if (el.textContent !== newTxt){
        el.textContent = newTxt;
        el.classList.remove('metric-pulse'); void el.offsetWidth; el.classList.add('metric-pulse');
      }
    }

    function updateClasses(statuses) {
      statuses.forEach((s, i) => {
        const el = wordsEls[i]; if (!el) return;
        el.classList.remove('correct','misread','skipped');
        if (s === 'correct') el.classList.add('correct');
        else if (s === 'misread') el.classList.add('misread');
        else if (s === 'skipped') el.classList.add('skipped');
      });
    }

    function fill(listEl, items) {
      listEl.innerHTML = items.length
        ? items.map(o =>
            `<li data-idx="${o.i ?? ''}">${esc(o.target || '')}${o.hyp ? ` → <i>${esc(o.hyp)}</i>` : ''}${Number.isFinite(o.i) ? ` <span class="muted">(#${o.i+1})</span>` : ''}</li>`
          ).join('')
        : '<li class="muted">None</li>';
    }

    function fillErrorPanelFromEvents(events) {
      fill(mispronList, events.filter(e => e.type === 'mispronunciation'));
      fill(omissionList, events.filter(e => e.type === 'omission'));
      fill(subList,      events.filter(e => e.type === 'substitution'));
      fill(insList,      events.filter(e => e.type === 'insertion'));
      fill(repList,      events.filter(e => e.type === 'repetition'));
      fill(transList,    events.filter(e => e.type === 'transposition'));
      fill(revList,      events.filter(e => e.type === 'reversal'));
    }

    function jumpFromListClick(e) {
      const li = e.target.closest('li[data-idx]'); if (!li) return;
      const idx = Number(li.dataset.idx);
      if (Number.isFinite(idx)) { currentIndex = idx; outlineCurrent(); scrollCurrentIntoView(); }
    }
    [mispronList, omissionList, subList, insList, repList, transList, revList].forEach(ul => ul?.addEventListener('click', jumpFromListClick));

    errorsCard?.addEventListener('click', () => {
      if (errorPanel.hidden){
        errorPanel.hidden = false; errorPanel.style.opacity = '0';
        errorPanel.animate([{opacity:0, transform:'translateY(-4px)'},{opacity:1, transform:'translateY(0)'}], {duration:180, easing:'ease-out'});
        setTimeout(()=>{ errorPanel.style.opacity='1'; }, 0);
      } else {
        errorPanel.animate([{opacity:1},{opacity:0}], {duration:140}).onfinish = ()=>{ errorPanel.hidden = true; };
      }
    });

    function computeAndRenderMetrics(status, events) {
      const attempted = status.filter(s => s !== 'pending').length;
      const correct   = status.filter(s => s === 'correct').length;

      const counts = {
        mispronunciation: events.filter(e=>e.type==='mispronunciation').length,
        omission:        events.filter(e=>e.type==='omission').length,
        substitution:    events.filter(e=>e.type==='substitution').length,
        insertion:       events.filter(e=>e.type==='insertion').length,
        repetition:      events.filter(e=>e.type==='repetition').length,
        transposition:   events.filter(e=>e.type==='transposition').length,
        reversal:        events.filter(e=>e.type==='reversal').length,
      };

      const errorsForWCPM = counts.omission + counts.substitution +
                            counts.mispronunciation + counts.transposition + counts.reversal;

      const minutes = Math.max((performance.now() - startedAt - pausedAccum) / 60000, 0.0001);
      const wcpm = (attempted - errorsForWCPM) / minutes;
      const accuracy = attempted ? (correct / attempted * 100) : 0;

      setMetric(wcpmEl, wcpm, 1);
      setMetric(accEl,  accuracy, 1);
      if (errEl.textContent !== String(errorsForWCPM)) {
        errEl.textContent = String(errorsForWCPM);
        errEl.classList.remove('metric-pulse'); void errEl.offsetWidth; errEl.classList.add('metric-pulse');
      }

      return { attempted, correct, wcpm, accuracy, counts };
    }

    // ---- Wrong Words playback (disabled during listening) ----
    function stopWrongQueue() {
      try { window.speechSynthesis.cancel(); } catch(e){}
      wrongSpeaking = false;
      if (btnWrong) btnWrong.textContent = 'Wrong Words ▶';
    }
    function buildWrongQueueFromEvents(events) {
      const speakable = new Set(['mispronunciation','substitution','insertion','repetition','transposition','reversal']);
      const items = events
        .filter(e => speakable.has(e.type) && e.hyp && /[a-z]/i.test(e.hyp))
        .map(e => ({ t: e.hyp, j: (typeof e.j === 'number' ? e.j : 999999) }));
      items.sort((a,b) => a.j - b.j);
      const out = [];
      for (const it of items) {
        if (out.length === 0 || out[out.length-1].toLowerCase() !== it.t.toLowerCase()) out.push(it.t);
      }
      return out;
    }
    function playWrongQueue(queue) {
      if (!queue || !queue.length) { stopWrongQueue(); return; }
      wrongSpeaking = true; if (btnWrong) btnWrong.textContent = 'Stop Wrong';
      const next = () => {
        const word = queue.shift(); if (!word) { stopWrongQueue(); return; }
        const u = new SpeechSynthesisUtterance(word);
        u.lang  = passage.dataset.lang || 'en-US'; u.rate = 1.0; u.pitch = 1.0;
        u.onend = () => next(); window.speechSynthesis.speak(u);
      };
      next();
    }
    btnWrong?.addEventListener('click', () => {
      if (wrongSpeaking) { stopWrongQueue(); return; }
      if (btnPause && !btnPause.disabled) { alert('Pause or Stop first to play the wrong words so it won’t affect recognition.'); return; }
      const q = buildWrongQueueFromEvents(lastEvents);
      if (!q.length) { alert('No wrong words to play.'); return; }
      playWrongQueue(q.slice());
    });

    function handleTokens() {
      const all = asr.getAllTokens();
      const sens = mapSensitivity(sensSlider.value);

      const { status, events } = aligner.align(tokens, all, {
        minConfidence: sens.minConfidence,
        finalOnly: true,
        maxEd: sens.maxEd,
        maxInsertionsShown: 8
      });

      lastStatus = status;
      lastEvents = events;

      updateClasses(status);
      fillErrorPanelFromEvents(events);

      const next = status.findIndex(s => s === 'pending');
      currentIndex = next === -1 ? tokens.length - 1 : next;
      outlineCurrent(); scrollCurrentIntoView();

      computeAndRenderMetrics(status, events);
      updateTypewriter(all);
    }

    async function start() {
      if (recording) return;

      let forced = false;
      if (forceServer?.checked) {
        if ('webkitSpeechRecognition' in window) {
          try { origWSR = window.webkitSpeechRecognition; } catch(e){}
          try { delete window.webkitSpeechRecognition; } catch(e){}
          try { window.webkitSpeechRecognition = undefined; } catch(e){}
          forced = true;
        }
      }

      try {
        const { stream } = await recorder.start();
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        mediaRecorder.start();
      } catch (e) {
        alert('Microphone permission denied or not available.');
        if (forced && origWSR) { try { window.webkitSpeechRecognition = origWSR; } catch(_){} }
        return;
      }

      btnWrong && (btnWrong.disabled = true);
      stopWrongQueue();

      resetTypewriter();

      startedAt = performance.now();
      pausedAccum = 0; pauseStart = 0; finalDurationSec = null;
      startTimerLoop();

      recording = true;
      btnStart.disabled = true; btnPause.disabled = false; btnStop.disabled = false;
      dot.classList.add('active');
      setStatus('Listening...');

      await asr.start(() => handleTokens());
      summary.hidden = false;

      if (asr.isUsingFallback()) { asrBanner && (asrBanner.style.display = 'inline'); }
      else { asrBanner && (asrBanner.style.display = 'none'); }
    }

    function pause() {
      if (!recording) return;
      recorder.stop(); asr.stop();
      pauseStart = performance.now();
      btnStart.disabled = false; btnPause.disabled = true;
      setStatus('Paused'); dot.classList.remove('active');
      btnWrong && (btnWrong.disabled = false);
    }

    function resume() {
      recorder.start(); asr.start(() => handleTokens());
      if (pauseStart) { pausedAccum += performance.now() - pauseStart; pauseStart = 0; }
      btnStart.disabled = true; btnPause.disabled = false;
      setStatus('Listening...'); dot.classList.add('active');
      btnWrong && (btnWrong.disabled = true); stopWrongQueue();
    }

    async function stop() {
      if (!recording) return;
      recording = false;

      recorder.stop(); asr.stop();
      if (pauseStart) { pausedAccum += performance.now() - pauseStart; pauseStart = 0; }

      const readEndedAt = performance.now();
      finalDurationSec = (readEndedAt - startedAt - pausedAccum) / 1000;
      cancelTimerLoop();
      liveTimerEl.textContent = ` • ${fmtSec(finalDurationSec)}s`;

      btnStart.disabled = false; btnPause.disabled = true; btnStop.disabled = true;
      setStatus('Stopped'); dot.classList.remove('active');

      if (origWSR) { try { window.webkitSpeechRecognition = origWSR; } catch(e){}; origWSR = null; }

      btnWrong && (btnWrong.disabled = false);

      if (asr.isUsingFallback()) {
        mediaRecorder.stop();
        await new Promise(r => mediaRecorder.onstop = r);
        const blob = new Blob(chunks, { type: 'audio/webm' });
        chunks = [];
        await asr.stopFallbackUpload(blob, () => handleTokens());
      }
    }

    btnStart.addEventListener('click', start);
    btnPause.addEventListener('click', () => { if (!btnPause.disabled) pause(); });
    btnStop .addEventListener('click', stop);

    // --- Keyboard shortcuts: ignore when typing in forms/panel ---
    function isTypingContext(e){
      const t = e.target;
      if (!t) return false;
      if (t.closest && t.closest('#studentPanel')) return true; // anywhere inside student panel
      if (t.isContentEditable) return true;
      const tag = (t.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (tag === 'INPUT') {
        const type = (t.getAttribute('type') || 'text').toLowerCase();
        const texty = new Set(['text','search','email','tel','url','password','number','date','time']);
        if (texty.has(type)) return true;
      }
      return false;
    }

    window.addEventListener('keydown', (e) => {
      if (isTypingContext(e)) return; // don't hijack while typing
      const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
      const isEnter = e.code === 'Enter' || e.key === 'Enter';
      const noMods = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (noMods && isSpace) { e.preventDefault(); if (btnPause.disabled) resume(); else pause(); }
      else if (noMods && isEnter) { e.preventDefault(); stop(); }
    });

    // ======== SAVE SESSION (uses sanitized values) ========
    saveBtn.addEventListener('click', async () => {
      const ok1 = requireField(surnameInput);
      const ok2 = requireField(firstInput);
      const ok3 = requireField(miInput);
      const ok4 = requireGrade();
      if (!(ok1 && ok2 && ok3 && ok4)) {
        alert('Please complete Surname, First Name, Middle Initial, and Grade Level before saving.');
        return;
      }

      const surname = sanitizeName(surnameInput.value, {max:64});
      const first   = sanitizeName(firstInput.value,   {max:64});
      const middle  = sanitizeName(miInput.value,      {max:24, uppercase:true});

      const { wcpm, accuracy, counts } = computeAndRenderMetrics(lastStatus, lastEvents);

      const dur = (finalDurationSec != null)
        ? finalDurationSec
        : (performance.now() - startedAt - pausedAccum) / 1000;

      const combinedName = `${surname}, ${first} ${middle}`.trim();

      const payload = {
        passage_id: window.APP.passageId,
        surname, first_name: first, middle_initial: middle,
        grade_level: gradeSel.value.trim(),
        student_name: combinedName,

        started_at: Date.now() / 1000,
        duration_sec: dur,
        wcpm, accuracy,
        errors: {
          mispronunciations: counts.mispronunciation,
          omissions: counts.omission,
          substitutions: counts.substitution,
          insertions: counts.insertion,
          repetitions: counts.repetition,
          transpositions: counts.transposition,
          reversals: counts.reversal,
          self_corrections: 0
        },
        word_events: Array.from(document.querySelectorAll('.word')).map((el, i) => {
          let st = 'pending';
          if (el.classList.contains('correct')) st = 'correct';
          else if (el.classList.contains('misread')) st = 'misread';
          else if (el.classList.contains('skipped')) st = 'skipped';
          return { word_index: i, status: st };
        })
      };

      let msgEl = document.getElementById('saveResult');
      if (!msgEl) {
        msgEl = document.createElement('div');
        msgEl.id = 'saveResult';
        msgEl.className = 'muted';
        msgEl.style.marginLeft = '8px';
        saveBtn.insertAdjacentElement('afterend', msgEl);
      }

      saveBtn.disabled = true;
      msgEl.textContent = 'Saving…';
      try {
        const res = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const j = await res.json();
        if (j && j.ok) {
          msgEl.textContent = `Saved session #${j.id}. Download PDF/CSV from Dashboard or Results.`;
        } else {
          msgEl.textContent = 'Save failed.';
          alert((j && j.error) ? j.error : 'Save failed.');
        }
      } catch (err) {
        console.error(err);
        msgEl.textContent = 'Save failed.';
        alert('Save failed.');
      } finally {
        saveBtn.disabled = false;
      }
    });
    // ========================================================
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
