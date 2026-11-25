import { fakeForgejo } from './forgejo.js';
import { fakeGitHub } from './github.js';
import { fakeGitLab } from './gitlab.js';

// One fake server per adapter in client/hosts/index.js. A test fails when a host has no fake here.
export const fakes = { github: fakeGitHub, gitlab: fakeGitLab, forgejo: fakeForgejo };
