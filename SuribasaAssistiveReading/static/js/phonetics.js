// Robust, dependency-free phonetic helpers (Soundex + lite Metaphone + reversal)
// Exposed API: { norm, soundex, isPhoneticMatch, isReversal }
window.phonetics = (function () {
  // --- Normalization helpers -------------------------------------------------

  // Remove diacritics and normalize punctuation (e.g., “smart quotes”)
  function asciiFold(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")   // strip combining marks
      .replace(/[‘’‛‚`´]/g, "'")
      .replace(/[“”‟„]/g, '"')
      .replace(/[‐-‒–—―]/g, "-");
  }

  // Collapse repeated letters: "coooool" -> "cool"
  function collapseRepeats(s) {
    return s.replace(/([a-z0-9'])\1{1,}/g, "$1");
  }

  // Keep letters, digits, apostrophes; lower-case; no spaces
  function norm(s) {
    const t = collapseRepeats(
      asciiFold(String(s || "").toLowerCase())
        .replace(/[^a-z0-9']/g, " ")
    );
    // keep inner apostrophes (don't for example -> dont)
    return t.replace(/\s+/g, "").replace(/(^'|'+$)/g, "");
  }

  // --- Soundex (classic) -----------------------------------------------------

  function soundex(s) {
    s = norm(s);
    if (!s) return "";
    const f = s[0];
    const map = {
      b: 1, f: 1, p: 1, v: 1,
      c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2,
      d: 3, t: 3,
      l: 4,
      m: 5, n: 5,
      r: 6
    };
    let code = f.toUpperCase(), prev = map[f] || 0;
    for (let i = 1; i < s.length; i++) {
      const c = map[s[i]] || 0;
      if (c !== 0 && c !== prev) code += c;
      prev = c;
    }
    return (code + "000").slice(0, 4);
  }

  // --- Tiny Metaphone-ish code (fast & forgiving, not full metaphone) --------

  function metaphoneLite(s) {
    s = norm(s);
    if (!s) return "";

    // common digraph simplifications
    s = s
      .replace(/^kn/, "n").replace(/^gn/, "n").replace(/^pn/, "n")
      .replace(/^wr/, "r").replace(/^ps/, "s")
      .replace(/ph/g, "f")
      .replace(/gh(?![aeiou])/g, "h")   // silent-ish gh
      .replace(/mb$/g, "m")
      .replace(/cq/g, "k").replace(/q/g, "k")
      .replace(/x/g, "ks");

    // drop vowels except at start
    const head = s[0];
    let tail = s.slice(1).replace(/[aeiouy]/g, "");
    s = head + tail;

    // collapse repeats again post-rules
    s = collapseRepeats(s);

    return s;
  }

  // --- Edit distance (for small wiggle on short words) -----------------------

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
      const ai = a.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
        const del = dp[idx(i - 1, j)] + 1;
        const ins = dp[idx(i, j - 1)] + 1;
        const sub = dp[idx(i - 1, j - 1)] + cost;
        dp[idx(i, j)] = Math.min(del, ins, sub);
      }
    }
    return dp[idx(n, m)];
  }

  // --- Public predicates ------------------------------------------------------

  // True if two words are likely the same by sound (for mispronunciation bucket)
  function isPhoneticMatch(a, b) {
    const A = norm(a), B = norm(b);
    if (!A || !B) return false;
    if (A === B) return true;

    // quick phonetic equivalence
    if (soundex(A) === soundex(B)) return true;
    if (metaphoneLite(A) === metaphoneLite(B)) return true;

    // small wiggle for short words (e.g., "brwn" vs "brown", "kat" vs "cat")
    const d = levenshtein(A, B);
    const minLen = Math.min(A.length, B.length);
    if (minLen <= 4) return d <= 1;
    return d <= 2 && A[0] === B[0];
  }

  // reversal like "saw" <-> "was" (used for the reversal miscue)
  function isReversal(tgt, hyp) {
    const t = norm(tgt), h = norm(hyp);
    return t.length > 2 && h === t.split("").reverse().join("");
  }

  return { norm, soundex, isPhoneticMatch, isReversal };
})();
