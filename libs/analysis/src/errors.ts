/** Base class for all @golf/analysis errors. */
export class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** No API key is configured — actionable: the user must add one in Settings. */
export class MissingKeyError extends AnalysisError {
  constructor(
    message = 'No Anthropic API key is configured. Add your API key in Settings to enable AI analysis.',
  ) {
    super(message);
  }
}

/** An HTTP-level failure from the Anthropic API, carrying the status code. */
export class AnalysisApiError extends AnalysisError {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** 401 — the key was rejected. */
export class AnalysisAuthError extends AnalysisApiError {
  constructor(
    message = 'Anthropic rejected the API key (401). Check the key saved in Settings.',
  ) {
    super(message, 401);
  }
}

/** 429 — rate limited. */
export class AnalysisRateLimitError extends AnalysisApiError {
  constructor(
    message = 'Anthropic rate limit reached (429). Wait a moment and try again.',
  ) {
    super(message, 429);
  }
}

/** 529 — the API is temporarily overloaded. */
export class AnalysisOverloadedError extends AnalysisApiError {
  constructor(
    message = 'Anthropic is temporarily overloaded (529). Try again shortly.',
  ) {
    super(message, 529);
  }
}

/** Any other 5xx / unexpected HTTP failure. */
export class AnalysisServerError extends AnalysisApiError {}

/** The model's structured output failed validation even after one repair attempt. */
export class AnalysisParseError extends AnalysisError {}

/** Map a non-2xx HTTP status to the matching typed error. */
export function apiErrorForStatus(
  status: number,
  detail?: string,
): AnalysisApiError {
  if (status === 401) {
    return detail ? new AnalysisAuthError(detail) : new AnalysisAuthError();
  }
  if (status === 429) {
    return detail
      ? new AnalysisRateLimitError(detail)
      : new AnalysisRateLimitError();
  }
  if (status === 529) {
    return detail
      ? new AnalysisOverloadedError(detail)
      : new AnalysisOverloadedError();
  }
  return new AnalysisServerError(
    detail ?? `Anthropic request failed with status ${status}.`,
    status,
  );
}

/** Map an SSE `error` event's error type to the matching typed error. */
export function apiErrorForType(
  errorType: string,
  message: string,
): AnalysisApiError {
  switch (errorType) {
    case 'authentication_error':
      return new AnalysisAuthError(message);
    case 'rate_limit_error':
      return new AnalysisRateLimitError(message);
    case 'overloaded_error':
      return new AnalysisOverloadedError(message);
    default:
      return new AnalysisServerError(message, 500);
  }
}
