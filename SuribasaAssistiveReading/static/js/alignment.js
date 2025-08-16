// Alignment with extended miscue taxonomy
// Returns { status[], insertions[], events[] }
// status[i] in ["pending","correct","misread","skipped"]
// events: [{type, i, target, hyp, confidence, j}]
window.aligner = (function () {
  const { norm, isPhoneticMatch, isReversal } = window.phonetics;

  // --- small helpers ---------------------------------------------------------
  function isPunc(w) { return /^[^\w']+$/.test(w); }

  function levenshtein(a, b) {
    if (a === b) return 0;
    const n = a.length, m = b.length;
    if (!n) return m;
    if (!m) return n;
    const dp = new Array((n + 1) * (m + 1));
    const idx = (i, j) => i * (m + 1) + j;
    for (let i = 0; i <= n; i++) dp[idx(i, 0)] = i;
    for (let j = 0; j <= m; j++) dp[idx(0, j)] = j;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        const del = dp[idx(i - 1, j)] + 1;
        const ins = dp[idx(i, j - 1)] + 1;
        const sub = dp[idx(i - 1, j - 1)] + cost;
        dp[idx(i, j)] = Math.min(del, ins, sub);
      }
    }
    return dp[idx(n, m)];
  }

  function nearEqual(a, b, maxEd) {
    if (a === b) return true;
    if (!maxEd) return false;
    return levenshtein(a, b) <= maxEd;
  }

  // --- DP alignment on reduced (non-punct) refs and filtered hyp tokens ------
  function alignTokens(ref, hypObjs) {
    const n = ref.length, m = hypObjs.length;
    const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
    const bt = Array.from({ length: n + 1 }, () => Array(m + 1).fill(null));

    for (let i = 0; i <= n; i++) { dp[i][0] = i; bt[i][0] = 'D'; }
    for (let j = 0; j <= m; j++) { dp[0][j] = j; bt[0][j] = 'I'; }
    bt[0][0] = '·';

    for (let i = 1; i <= n; i++) {
      const r = ref[i - 1].n;
      for (let j = 1; j <= m; j++) {
        const h = hypObjs[j - 1].n;
        const cSub = dp[i - 1][j - 1] + (r === h ? 0 : 1);
        const cDel = dp[i - 1][j] + 1;
        const cIns = dp[i][j - 1] + 1;
        const best = Math.min(cSub, cDel, cIns);
        dp[i][j] = best;
        bt[i][j] = (best === cSub) ? 'S' : (best === cDel ? 'D' : 'I');
      }
    }

    // backtrack
    let i = n, j = m;
    const ops = [];
    while (i > 0 || j > 0) {
      const op = bt[i][j];
      if (op === 'S') { ops.push(['S', i - 1, j - 1]); i--; j--; }
      else if (op === 'D') { ops.push(['D', i - 1, j]); i--; }
      else { ops.push(['I', i, j - 1]); j--; }
    }
    return ops.reverse();
  }

  // --- classify ops into status + events ------------------------------------
  function classify(ops, ref, hypObjs, minConf = 0.62, maxEd = 0, maxInsertionsShown = 8) {
    const status = Array(ref.length).fill('pending');
    const events = [];
    const inserted = [];

    for (let k = 0; k < ops.length; k++) {
      const [op, i, j] = ops[k];

      if (op === 'S') {
        const r = ref[i];      // { raw, n, oIdx }
        const h = hypObjs[j];  // { raw, n, conf, j }
        const conf = (h.conf ?? 0.8);

        // treat near-equal within maxEd as correct (helps with tiny ASR fuzz)
        const match = (r.n === h.n) || nearEqual(r.n, h.n, maxEd);
        if (match && conf >= minConf) {
          status[i] = 'correct';
        } else {
          status[i] = 'misread'; // provisional bucket
          events.push({ type: 'S?', i: r.oIdx, target: r.raw, hyp: h.raw, confidence: conf, j: h.j });
        }

      } else if (op === 'D') {
        const r = ref[i];
        status[i] = 'skipped';
        events.push({ type: 'omission', i: r.oIdx, target: r.raw });

      } else if (op === 'I') {
        const h = hypObjs[j]; // may be undefined if j<0; guard:
        if (!h) continue;
        inserted.push(h.raw);
        const prevRefIdx = Math.max(0, i - 1);
        events.push({
          type: 'insertion',
          i: ref[Math.max(0, i - 1)]?.oIdx ?? 0,
          target: ref[Math.max(0, i - 1)]?.raw,
          hyp: h.raw,
          confidence: h.conf ?? 0.8,
          j: h.j
        });
      }
    }

    // detect transpositions (adjacent swaps on S? pairs)
    for (let k = 0; k < events.length - 1; k++) {
      const a = events[k], b = events[k + 1];
      if (a.type === 'S?' && b.type === 'S?') {
        if (norm(a.hyp) === norm(ref.find(r => r.oIdx === b.i)?.raw || '') &&
            norm(b.hyp) === norm(ref.find(r => r.oIdx === a.i)?.raw || '')) {
          a.type = 'transposition';
          b.type = 'transposition';
        }
      }
    }

    // refine S? to mispronunciation / substitution / reversal
    for (const e of events) {
      if (e.type === 'S?') {
        if (isReversal(e.target, e.hyp)) e.type = 'reversal';
        else if (isPhoneticMatch(e.target, e.hyp)) e.type = 'mispronunciation';
        else e.type = 'substitution';
      }
    }

    // mark repetitions (inserted token equals previous hyp or current ref)
    for (let idx = 0; idx < events.length; idx++) {
      const e = events[idx];
      if (e.type === 'insertion') {
        const prevHyp = events[idx - 1]?.hyp || '';
        const refTok = ref.find(r => r.oIdx === e.i)?.raw || '';
        if (norm(e.hyp) === norm(prevHyp) || norm(e.hyp) === norm(refTok)) {
          e.type = 'repetition';
        }
      }
    }

    // prepare compact insertion line (last N unique-ish)
    const line = [];
    for (let i = Math.max(0, inserted.length - 50); i < inserted.length; i++) {
      const w = String(inserted[i] || '').trim();
      if (!w) continue;
      if (line.length && line[line.length - 1].toLowerCase() === w.toLowerCase()) continue;
      line.push(w);
    }
    const insertionsLine = line.slice(-Math.max(1, maxInsertionsShown));

    // inflate status already uses reduced ref; translate to final later
    return { status, insertions: insertionsLine, events };
  }

  // --- public align ----------------------------------------------------------
  function align(refWords, hypTokens, opts = {}) {
    const minConfidence = opts.minConfidence ?? 0.62;
    const finalOnly = !!opts.finalOnly;
    const maxEd = opts.maxEd ?? 0;
    const maxInsertionsShown = opts.maxInsertionsShown ?? 8;

    // 1) Build reduced ref (drop punctuation) but remember original indices
    const ref = [];
    const mapIdx = [];
    for (let i = 0; i < refWords.length; i++) {
      const w = refWords[i];
      if (!isPunc(w)) {
        ref.push({ raw: w, n: norm(w), oIdx: i });
        mapIdx.push(i);
      }
    }

    // 2) Filter hyp tokens
    const hypObjs = [];
    for (let j = 0; j < hypTokens.length; j++) {
      const t = hypTokens[j];
      if (!t || !t.text) continue;
      if (finalOnly && !t.final) continue;
      const raw = String(t.text);
      const n = norm(raw);
      if (!n) continue;
      hypObjs.push({ raw, n, conf: (t.confidence ?? t.conf ?? 0.8), j });
    }

    // 3) DP align on reduced strings
    const ops = alignTokens(ref, hypObjs);

    // 4) Classify -> reduced status + events
    const { status: stReduced, insertions, events } =
      classify(ops, ref, hypObjs, minConfidence, maxEd, maxInsertionsShown);

    // 5) Inflate status back to original token slots
    const status = Array(refWords.length).fill('pending');
    for (let r = 0; r < ref.length; r++) {
      status[ref[r].oIdx] = stReduced[r];
    }

    return { status, insertions, events };
  }

  return { align };
})();
