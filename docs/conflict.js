// Thrown when a write is based on a state that is no longer current.
export class Conflict extends Error {
  constructor(message = 'The data changed since it was read.') { super(message); this.name = 'Conflict'; }
}
