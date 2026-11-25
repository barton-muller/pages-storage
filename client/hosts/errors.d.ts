export class Conflict extends Error {}
export class HostError extends Error { host?: string; call?: string; status?: number }
export class Unauthorized extends HostError {}
export class NotFound extends HostError {}
export class RateLimited extends HostError {}
export class HostUnreachable extends HostError {}
export class Unsupported extends HostError {}
export class ApiMismatch extends HostError { missing?: string[] }
