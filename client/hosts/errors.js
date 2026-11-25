// Errors every host adapter uses, so callers handle them the same way whatever the host is.
//
//   Conflict         the data changed since it was read (from conflict.js)
//   Unauthorized     the token is wrong, expired or lacks permission
//   NotFound         the repo (or a file the caller needs) does not exist, or the token cannot see it
//   RateLimited      the host asked us to slow down
//   HostUnreachable  no answer at all: wrong address, no network, or the server does not allow web pages (CORS)
//   Unsupported      something this host (or this adapter) does not do, said plainly
//   ApiMismatch      the host answered, but not in the shape the adapter expects. Either the host changed its API or this is
//                    not the kind of server the adapter thinks it is. The message names the call and the missing field.
//
// All except Conflict carry .host (adapter id), .call ("GET /repository/tree") and .status (HTTP status, when there was one).

import { Conflict } from '../conflict.js';
export { Conflict };

export class HostError extends Error {
  constructor(message, { host, call, status } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.host = host;
    this.call = call;
    this.status = status;
  }
}
export class Unauthorized extends HostError {}
export class NotFound extends HostError {}
export class RateLimited extends HostError {}
export class HostUnreachable extends HostError {}
export class Unsupported extends HostError {}
export class ApiMismatch extends HostError {
  constructor(message, ctx) {
    super(message, ctx);
    this.missing = ctx?.missing;
  }
}
