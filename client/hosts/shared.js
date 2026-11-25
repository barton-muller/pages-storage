export const b64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
export const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(String(s).replace(/\s/g, '')), (c) => c.charCodeAt(0)));
export const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
// A token is a string, or a function that returns one (a sign-in that refreshes its token).
export const resolveToken = async (token) => (typeof token === 'function' ? token() : token);
