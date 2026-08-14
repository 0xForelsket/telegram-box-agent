/**
 * An error whose message was written for the person who triggered it.
 *
 * `getUserFacingErrorMessage` deliberately discards most error text so provider
 * internals and stack detail never reach a chat. That default is wrong for
 * policy and admission failures — "you have reached the daily limit of 5 Box
 * jobs" is the whole answer, and replacing it with a generic error leaves the
 * user with no idea what to do next. Throw this when the message is the point.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export function isUserFacingError(error: unknown): error is UserFacingError {
  return error instanceof UserFacingError
    // Survives a structured-clone or cross-realm boundary, where `instanceof`
    // stops holding but the tag does not.
    || (error instanceof Error && error.name === 'UserFacingError');
}
