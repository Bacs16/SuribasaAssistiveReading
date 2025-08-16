window.utils = (function(){
  function normalizeToken(t){
    return (t||'').toLowerCase().replace(/[^a-z0-9']/g,'').trim();
  }
  function tokenize(text){
    return (text||'').match(/[A-Za-z']+|[0-9]+|\S/g)||[];
  }
  function nowMs(){ return performance.now(); }
  return { normalizeToken, tokenize, nowMs };
})();