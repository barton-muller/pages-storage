// For tests of your own code that uses a store: a fake server for every host, and the conformance suite.
//   import { fakes } from 'pages-storage/testing';
//   const server = fakes.gitlab();          // { fetch, seed(files), files(), commitElsewhere(changes), ... }
//   const store = await storeFromUrl('https://gitlab.com/me/data.git', { token: 't', fetch: server.fetch });
// Node only.
export { fakes } from './fakes/index.js';
export { runConformance } from './conformance.js';
