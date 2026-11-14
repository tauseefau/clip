// Loaded by every page before its module script. A no-op unless the page was opened with ?token=.
{
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem('clip.token', fromUrl);
    url.searchParams.delete('token');
    history.replaceState(null, '', url); // keep it out of history and the Copy link button
  }
  const token = localStorage.getItem('clip.token');
  if (token) {
    const nativeFetch = window.fetch;
    window.fetch = (input, init = {}) => nativeFetch(input, { ...init, headers: { ...init.headers, 'x-clip-token': token } });
  }
}
