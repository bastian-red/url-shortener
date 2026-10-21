/**
 * One error vocabulary, crossing every boundary.
 *
 * `apps/api`'s DomainErrorFilter maps these to HTTP statuses. The services under
 * `services/` throw these rather than Nest exceptions, so none of them depends on
 * a web framework and each is unit tested with plain objects.
 *
 * Clients match on `code`, never on prose. The message is for a person.
 */

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID',
  'CONFLICT',
  'TOO_LARGE',
  'GONE',
  'UNPROCESSABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class DomainError extends Error {
  /**
   * `details` is structured data a client acts on -- the analyzer's issue list
   * on a refused publish, each naming a field and an edge. It is never an error
   * object or a stack: the filter puts it on the wire verbatim.
   */
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
    // Without this, `instanceof DomainError` is false when the class is compiled
    // to ES5-era output and the prototype chain is rebuilt by the constructor.
    // The target here is ES2022 so it holds anyway; it is one line of insurance
    // against a tsconfig change that would otherwise break every catch block
    // silently rather than at compile time.
    Object.setPrototypeOf(this, DomainError.prototype);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/**
 * The HTTP status each code answers with.
 *
 * `Record<ErrorCode, number>` is the enforcement: adding a code to `ERROR_CODES`
 * without adding it here does not compile.
 *
 * Three are not the obvious status and are the reason the table is worth reading:
 *
 * - `NOT_FOUND` (404) is also what "this link is somebody else's" answers. An
 *   owner probing ids must not be able to tell a link that exists from one that
 *   does not; "403 here, 404 there" is a directory listing.
 * - `GONE` (410) is a link that exists and has expired or hit its click limit. The
 *   visitor is told the truth, because the link was real.
 * - `UNPROCESSABLE` (422) is a well-formed request the domain refuses on its
 *   merits: a click limit below the clicks already counted. 400 would say "fix the
 *   shape of your request", which is not the problem.
 */
export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  // Nobody proved who they are. Distinct from FORBIDDEN, which is somebody known
  // whose role is too weak, and the distinction is the one a client acts on: 401
  // means get a new token, 403 means stop asking.
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID: 400,
  CONFLICT: 409,
  TOO_LARGE: 413,
  GONE: 410,
  UNPROCESSABLE: 422,
});

/** The status for a code, or 500 for a string that is not one. */
export function httpStatusForCode(code: string): number {
  return Object.prototype.hasOwnProperty.call(HTTP_STATUS, code)
    ? HTTP_STATUS[code as ErrorCode]
    : 500;
}

/**
 * The inverse: a status back to the code that produces it, or null.
 *
 * Built by inverting `HTTP_STATUS` rather than written out, so the two can never
 * disagree. It exists for exactly one caller -- `apps/api`'s error filter, which
 * has to give a `code` to the exceptions Nest raises on its own (`401
 * Unauthorized`, `404 Not Found`), whose bodies carry a `statusCode` and no code
 * at all. Without it, "every response carries a code" would be true of every
 * response the application throws and false of the ones the framework throws --
 * and a 401 is the first one a client meets.
 */
const CODE_BY_STATUS: ReadonlyMap<number, ErrorCode> = new Map(
  ERROR_CODES.map((code) => [HTTP_STATUS[code], code] as const),
);

export function codeForHttpStatus(status: number): ErrorCode | null {
  return CODE_BY_STATUS.get(status) ?? null;
}
