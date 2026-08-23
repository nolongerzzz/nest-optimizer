async function boot() {
  const names = ['z0.b64', 'z1.b64', 'z2.b64'];
  const parts = await Promise.all(names.map(n => fetch(n + '?v=' + Date.now()).then(r => {
    if (!r.ok) throw new Error('Missing ' + n);
    return r.text();
  })));
  const b64 = parts.join('');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const code = await new Response(stream).text();
  const blob = new Blob([code], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  await import(url);
}
boot().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin',
    '<p style="color:#f87171;padding:20px;font-family:sans-serif">Engine load failed: ' + err.message + '</p>');
});
