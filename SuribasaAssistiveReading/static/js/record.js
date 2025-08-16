window.recorder = (function(){
  let audioCtx, analyser, dataArray, rafId, canvas, ctx;
  function init(canvasId='vu'){
    canvas = document.getElementById(canvasId);
    ctx = canvas.getContext('2d');
  }
  async function start(){
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    src.connect(analyser);
    draw();
    return { stream };
  }
  function draw(){
    if(!ctx) return;
    rafId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const barWidth = (canvas.width / dataArray.length);
    let x = 0;
    for(let i=0;i<dataArray.length;i++){
      const barHeight = dataArray[i]/255 * canvas.height;
      ctx.fillRect(x, canvas.height-barHeight, barWidth-1, barHeight);
    }
  }
  function stop(){
    if(rafId) cancelAnimationFrame(rafId);
    if(audioCtx) audioCtx.close();
  }
  return { init, start, stop };
})();