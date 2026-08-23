// Full engine loader — concatenates chunk files then runs as module
async function boot() {
  const names = ['nest-chunk-0.js.txt', 'nest-chunk-1.js.txt', 'nest-chunk-2.js.txt'];
  const texts = await Promise.all(names.map(n => fetch(n + '?v=' + Date.now()).then(r => {
    if (!r.ok) throw new Error('Missing ' + n);
    return r.text();
  })));
  const code = texts.join('');
  const blob = new Blob([code], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  await import(url);
}
boot().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin',
    '<p style="color:#f87171;padding:20px;font-family:sans-serif">Engine load failed: ' + err.message + '</p>');
});
