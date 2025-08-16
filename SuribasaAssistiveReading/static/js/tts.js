window.tts = (function(){
  let lastSpeak = 0;
  const MIN_GAP = 600; // ms
  function speakOnce(word){
    const t = performance.now();
    if(t - lastSpeak < MIN_GAP) return;
    lastSpeak = t;
    const u = new SpeechSynthesisUtterance(word);
    try { u.lang = 'en-US'; } catch(e){}
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }
  return { speakOnce };
})();