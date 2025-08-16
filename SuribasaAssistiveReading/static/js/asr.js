// static/js/asr.js
window.asr = (function () {
  let recognizer, useBrowser = false, usingFallback = false, lang = 'en-US';
  const asrTokens = [];          // [{text, confidence, final}]
  let finalSoFar = [];           // only FINAL tokens we've already accepted

  function init(options){ lang = (options && options.lang) || 'en-US';
    useBrowser = ('webkitSpeechRecognition' in window);
  }

  function tokenize(s){
    return (s||'').trim().split(/\s+/).filter(Boolean);
  }

  function pushFinalDelta(chunkWords, conf){
    // If engine returns cumulative transcript, take tail delta
    let deltaStart = 0;
    const nA = finalSoFar.length, nB = chunkWords.length;

    if (nB >= nA) {
      // common prefix length
      let k = 0;
      while (k < nA && finalSoFar[k].toLowerCase() === chunkWords[k].toLowerCase()) k++;
      deltaStart = k;
    } else {
      // if chunk is wholly already included (often happens), skip
      let isSuffix = true;
      for (let k = 0; k < nB; k++){
        if (finalSoFar[nA - nB + k]?.toLowerCase() !== chunkWords[k].toLowerCase()){ isSuffix = false; break; }
      }
      if (isSuffix) return;
    }

    for (let i = deltaStart; i < chunkWords.length; i++){
      const w = chunkWords[i];
      // drop immediate dup token
      if (finalSoFar.length && finalSoFar[finalSoFar.length-1].toLowerCase() === w.toLowerCase()) continue;
      finalSoFar.push(w);
      asrTokens.push({ text: w, confidence: conf ?? 0.85, final: true });
    }
  }

  function start(onTokens){
    if (useBrowser){
      recognizer = new webkitSpeechRecognition();
      recognizer.continuous = true;
      recognizer.interimResults = true;
      recognizer.lang = lang;

      recognizer.onresult = (evt) => {
        for (let i = evt.resultIndex; i < evt.results.length; i++){
          const res = evt.results[i];
          const txt = res[0].transcript || '';
          const conf = res[0].confidence ?? 0.85;

          if (res.isFinal){
            const words = tokenize(txt);
            // accept only the new delta words
            pushFinalDelta(words, conf);
            onTokens([]); // trigger re-align; we mutated asrTokens
          }
          // ignore interim for alignment (we use finalOnly), so no token spam
        }
      };

      recognizer.onerror = () => { useBrowser = false; usingFallback = true; };
      recognizer.start();
      return Promise.resolve();
    } else {
      usingFallback = true;
      return Promise.resolve();
    }
  }

  function stop(){ if (recognizer){ try{ recognizer.stop(); }catch(_){} } }
  function isUsingFallback(){ return usingFallback; }
  function getAllTokens(){ return asrTokens.slice(); }

  // Fallback upload kept as-is (it returns tokens from server already segmented)
  async function stopFallbackUpload(blob, onTokens){
    const fd = new FormData();
    fd.append('audio', blob, 'rec.webm');
    fd.append('lang', lang.split('-')[0]);
    try {
      const res = await fetch('/api/asr', { method: 'POST', body: fd });
      const j = await res.json();
      if (j.ok && Array.isArray(j.tokens)){
        // append once; prevent dup by checking tail
        j.tokens.forEach(t => pushFinalDelta([t.text], t.confidence));
        onTokens([]);
      }
      return j;
    } catch(e){ return { ok:false, error:String(e) }; }
  }

  return { init, start, stop, stopFallbackUpload, isUsingFallback, getAllTokens };
})();
